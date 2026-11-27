// A thread's guests and the threads you start yourself, as
// data: who's in a thread, who its box can bring in, and who what you write goes to. Guests.tsx draws them, talk.ts
// sends to them.
import { create } from "zustand";
import { DEFAULT_KIND, hiddenAgent, kindCaps, sortAgents } from "../../lib/agents.ts";
import { agentOf, allRows, getApp, threadRow } from "../../lib/store.ts";
import type { AgentSeen, Message, Thread } from "../../lib/types.ts";
import type { SaidMsg } from "./types.ts";
import { guestsOn, guestWords, together } from "../post/PostHead.tsx";
import { reEsc } from "../../lib/format.ts";
import { namesIn } from "../../../plugin/shared/mentions.ts";

// Who's in a thread, and how each is doing: the core area's (post/PostHead.tsx), as the thread's head shows them.
export { guestsOn, guestWords, together };

// A guest of a thread: a thread of its own, and when it was taken out (`removed`).
export type Guest = Thread & { removed?: string | null };
// A row of the @ list in a thread's box: who's in it ("in"), an agent it can bring in ("bring"), or a thread of yours
// that can join it as it is ("join"). `to`: "thread:<id>", "agent:<id>" or "join:<id>".
export interface GuestRow {
  kind: "in" | "bring" | "join";
  to: string;
  agent: string | null;
  name: string;
  sub: string;
  hay: string;
  // The machine it runs on, a chip by its name: the same agent can be on two of yours.
  machine?: string | null;
}

// A guest is a thread of its own: what it says shows in the thread it's a guest in. The agents a thread can bring
// in: those whose runtime takes guests (shared/runtimes.ts): the ones that work in a folder (Claude Code, Codex,
// Hermes), and OpenClaw's, which go by the conversation.
export const guestKind = (kind: string | null | undefined) => !!kindCaps(kind || DEFAULT_KIND)?.guests;
const dataOf = () => getApp().data;
// The machine an agent or a thread runs on: this one when it doesn't say, none for a cloud thread.
const machineOf = (x: { machine?: string | null; cloud?: unknown }) => (x.cloud ? null : x.machine || dataOf()?.machine || null);
// The chrome's small rows don't carry a guest roster. Address replies from the open conversation or its feed card.
export const threadForReply = (id: string) => {
  const s = getApp();
  return (s.open?.detail?.id === id ? s.open.detail : null) || (s.feed?.records[`thread:${id}`] as Thread) || threadRow(id);
};

// Where an agent brought into thread `s` works, as the server's guestPlace has it: "none" (it has no folders),
// "same" (the thread's folder, on its machine), or "other" (its own machine's checkout, or a folder of the thread's).
export const guestPlace = (s: Thread, a: AgentSeen) => (a.folders === false ? "none" : (s.root || s.cwd) && !s.cloud && agentOf(s.agent).folders !== false && (a.machine || dataOf()?.machine) === (s.machine || dataOf()?.machine) ? "same" : "other");
export const guestPlaceWords = (s: Thread, a: AgentSeen) => {
  const how = guestPlace(s, a);
  return how === "none" ? "A thread of its own, with no folder: it goes by what's said here" : how === "same" ? "A thread of its own, in this thread's folder" : "A thread of its own, in a checkout or folder there";
};
const hitter = (words: string[]) => (hay: string) => words.every((x) => new RegExp(`(^|[\\s_,(:/.-])${reEsc(x)}`).test(hay.toLowerCase()));

// The rows @ lists in a thread's box: who's in it, then your agents it can bring in. A guest's own box writes to it alone.
export function guestRows(id: string, words: string[], menu = false): GuestRow[] {
  const s = threadForReply(id);
  if (s?.talk) return s.mine === false ? [] : talkRows(s, words);
  if (!s || s.mine === false || (s.guest_of && (typeof s.guest_of === "string" || !s.guest_of.removed))) return [];
  const hit = hitter(words);
  const inIt: GuestRow[] = together(s).map((x) => {
    const host = "host" in x && x.host;
    const machine = machineOf(host ? s : (x as Thread));
    return { kind: "in", to: `thread:${x.id}`, agent: x.agent, name: x.name, sub: host ? `${x.label} · this thread's agent` : `${x.label} · guest, ${guestWords(x as Thread)}`, hay: `${x.name} ${x.label} ${agentOf(x.agent).name} ${machine || ""}`, machine };
  });
  const bring: GuestRow[] = sortAgents((dataOf()?.agents || []).filter((a) => a.mine !== false && !hiddenAgent(a) && guestKind(a.kind)))
    .filter((a) => a.id === s.agent || !guestsOn(s).some((g) => g.agent === a.id))
    .map((a) => ({ kind: "bring", to: `agent:${a.id}`, agent: a.id, name: a.id === s.agent || guestsOn(s).some((g) => g.agent === a.id) ? `${a.name} (new)` : a.name, sub: guestPlaceWords(s, a), hay: `${a.name} ${machineOf(a) || ""}`, machine: machineOf(a) }));
  return [...inIt, ...bring, ...joinRows(s, words, menu)].filter((r) => hit(r.hay));
}
// Your threads that are running, for a box's @ (`s`: the thread it's in, null in the composer): one joins as it is,
// with its session, its folder and what it knows. The menu shows the latest few until you type; a name typed by hand
// finds any of them.
export function joinRows(s: Thread | null, words: string[], menu = false): GuestRow[] {
  const taken = new Set(guestsOn(s).map((g) => g.id));
  const running: GuestRow[] = allRows()
    .filter((r) => r.id !== s?.id && r.mine !== false && !r.talk && !r.archived && !r.hidden && !r.cloud && !r.guest_of && !taken.has(r.id) && r.state !== "done" && r.label && guestKind(agentOf(r.agent).kind) && !hiddenAgent(agentOf(r.agent)))
    .sort((a, b) => (b.updated || b.started || "").localeCompare(a.updated || a.started || ""))
    .map((r) => ({ kind: "join", to: `join:${r.id}`, agent: r.agent, name: r.label, sub: `${r.title ? `${r.title.length > 60 ? `${r.title.slice(0, 59)}…` : r.title} · ` : ""}${agentOf(r.agent).name}, ${guestWords(r)}`, hay: `${r.label} ${r.title || ""} ${agentOf(r.agent).name} ${machineOf(r) || ""}`, machine: machineOf(r) }));
  return menu && !words.length ? running.slice(0, 5) : running;
}
export const targetName = (t: string) => (t.startsWith("join:") ? threadRow(t.slice(5))?.label || "a thread" : agentOf(t.slice(t.indexOf(":") + 1)).name);
// The @addresses in a thread's box, with `host` when its own agent is named. With none, replyTargets uses the picker.
export function boxTargets(id: string, text: string): { to: string[]; host: boolean } {
  const rows = guestRows(id, []);
  const to: string[] = [];
  for (const name of namesIn(text, rows.map((r) => r.name))) {
    const matches = rows.filter((r) => r.name.toLowerCase() === name);
    const here = matches.filter((r) => r.kind === "in");
    // A name already in this conversation doesn't also bring in a namesake from another machine. One that isn't brings
    // in one agent, not each machine's Claude: the one that works in this thread's folder, else the first.
    const bring = matches.filter((r) => r.kind === "bring");
    const s = bring.length > 1 ? threadForReply(id) : null;
    const one = (s && bring.find((r) => guestPlace(s, agentOf(r.agent)) === "same")) || bring[0];
    for (const r of here.length ? here : matches.filter((r) => r.kind !== "bring" || r === one)) if (!to.includes(r.to)) to.push(r.to);
  }
  return { to: to.filter((t) => t !== `thread:${id}`), host: to.includes(`thread:${id}`) };
}

// The composer keeps an explicit recipient per thread. Unlike a handover, this changes only where its messages
// go. A removed guest remains an invalid selection until you choose again: never silently send its draft to the host.
export const useReplyTo = create<{ to: Record<string, string> }>(() => ({ to: {} }));
export const setReplyTo = (id: string, recipient: string) => useReplyTo.setState((s) => ({ to: { ...s.to, [id]: recipient } }));
export const replyPeople = (s: Thread) => together(s).filter((x) => x.id === s.id || s.mine !== false);
export const replyPerson = (s: Thread, picked = useReplyTo.getState().to) => replyPeople(s).find((x) => x.id === (picked[s.id] || s.id)) || null;
export const replyName = (s: { agent?: string | null; label?: string | null }) => `${agentOf(s.agent).name}${s.label ? ` · ${s.label}` : ""}`;
export const hasReplyPicker = (s: Thread) => replyPeople(s).length > 1 || !!useReplyTo.getState().to[s.id];
// @mentions remain explicit addresses, and can name several agents or bring a new one in. Slash command arguments
// aren't addresses: commands belong to the selected recipient, even when their arguments contain an @name.
export const replyMentions = (id: string, text: string) => text.startsWith("/") ? { to: [], host: false } : boxTargets(id, text);
export function replyTargets(s: Thread, text: string): { to: string[]; host: boolean } | null {
  const named = replyMentions(s.id, text);
  if (named.to.length || named.host) return named;
  const recipient = replyPerson(s);
  return !recipient ? null : recipient.id === s.id ? { to: [], host: true } : { to: [`thread:${recipient.id}`], host: false };
}
// The actual receivers, for their queue state and command support; a new agent has no thread yet.
export function replyThreads(s: Thread, text: string): Thread[] {
  const targets = replyTargets(s, text);
  return !targets ? [] : [
    ...(targets.host ? [s] : []),
    ...targets.to.filter((t) => t.startsWith("thread:")).map((t) => {
      const id = t.slice(7);
      const g = guestsOn(s).find((g) => g.id === id);
      const row = threadForReply(id);
      return g ? { ...row, ...g } : row;
    }).filter(Boolean),
  ];
}

/* ---------- threads you start yourself ---------- */

// The agents a thread of yours can bring in: yours that can be a guest, on any machine of yours.
export const talkAgents = () => sortAgents((dataOf()?.agents || []).filter((a) => a.mine !== false && !hiddenAgent(a) && guestKind(a.kind)));
// What @ lists in a box of yours (`s`, the thread; null in the composer): who's in it, then who it can bring in.
export function talkRows(s: Thread | null, words: string[], menu = false): GuestRow[] {
  const hit = hitter(words);
  const on = s ? guestsOn(s) : [];
  const inIt: GuestRow[] = on.map((g) => ({ kind: "in", to: `thread:${g.id}`, agent: g.agent, name: agentOf(g.agent).name, sub: `${g.label || "its thread"} · ${guestWords(g)}`, hay: `${agentOf(g.agent).name} ${g.label || ""} ${machineOf(g) || ""}`, machine: machineOf(g) }));
  const bring: GuestRow[] = talkAgents()
    .filter((a) => !on.some((g) => g.agent === a.id))
    .map((a) => ({ kind: "bring", to: `agent:${a.id}`, agent: a.id, name: a.name, sub: a.folders === false ? "A thread of its own, with no folder: it goes by what's said here" : "A thread of its own", hay: `${a.name} ${machineOf(a) || ""}`, machine: machineOf(a) }));
  return [...inIt, ...bring, ...joinRows(s, words, menu)].filter((r) => hit(r.hay));
}
export function talkNamed(text: string, s: Thread | null): string[] {
  const rows = talkRows(s, []);
  const named = namesIn(text, rows.map((r) => r.name));
  const to: string[] = [];
  for (const r of rows) if (named.includes(r.name.toLowerCase())) to.push(r.to);
  return [...new Set(to)];
}
// Who a thread of yours's reply goes to, once you took one off its To row (by thread).
export const useTalkTo = create<{ to: Record<string, string[]> }>(() => ({ to: {} }));
export const setTalkTo = (id: string, to: string[] | null) =>
  useTalkTo.setState((st) => {
    const next = { ...st.to };
    if (to) next[id] = to;
    else delete next[id];
    return { to: next };
  });
// Who its reply goes to unless you change it: the guest that spoke last.
export function talkToNow(s: Thread, msgs: Message[], picked: Record<string, string[]> = useTalkTo.getState().to): string[] {
  if (picked[s.id]) return picked[s.id];
  const on = new Set(guestsOn(s).map((g) => g.id));
  const last = [...(msgs as SaidMsg[])].reverse().find((m) => m.guest && m.from === "agent" && on.has(m.guest));
  return last ? [`thread:${last.guest}`] : [];
}
// One it goes to: the agent, and its thread's label when it's a guest.
export const talkTarget = (s: Thread, t: string) => {
  const id = t.slice(t.indexOf(":") + 1);
  const g = t.startsWith("thread:") ? guestsOn(s).find((x) => x.id === id) : null;
  return { agent: g ? g.agent : id, label: g?.label || null };
};
// The messages the page has of a thread: its own page's, else its card's latest.
export const msgsOf = (s: Thread): Message[] => {
  const o = getApp().open;
  return o?.detail?.id === s.id ? o.detail.messages || [] : s.last_messages || [];
};
