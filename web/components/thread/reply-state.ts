// What a reply's card keeps while you're on the page (the old S.acted, S.quickSent, S.cardPick, S.slotPick,
// S.msgOpen, S.open, S.baAt): which of its buttons went ahead, whether a suggested reply went, the cards and the time
// you picked, what's open, and where a before-and-after's handle is. Gone when you reload, as before.
import { create } from "zustand";

export interface ReplyState {
  // "<message>:<key>" of each button that went ahead (a draft's, a card's, a time's, a to-do's answer).
  acted: Set<string>;
  // The messages a suggested reply of went.
  quickSent: Set<string>;
  // On cards that go together, and on a reply's to-dos with answers ("<message>:todos"): the button picked on each,
  // by its index.
  cardPick: Record<string, Record<number, number>>;
  // The time picked, by message.
  slotPick: Record<string, string | undefined>;
  // The long messages shown whole.
  msgOpen: Set<string>;
  // A reply's parts that are open (a draft read in full, its unchecked rows).
  open: Set<string>;
  // A before and after's handle, by message, 0–100.
  baAt: Record<string, number>;
}
export const useReply = create<ReplyState>(() => ({ acted: new Set(), quickSent: new Set(), cardPick: {}, slotPick: {}, msgOpen: new Set(), open: new Set(), baAt: {} }));
const R = useReply.getState;
const setR = useReply.setState;

// A set with `k` in or out.
const flip = (set: Set<string>, k: string): Set<string> => {
  const next = new Set(set);
  if (next.has(k)) next.delete(k);
  else next.add(k);
  return next;
};

export const useMsgOpen = (id: string) => useReply((s) => s.msgOpen.has(id));
export const toggleMsgOpen = (id: string) => setR({ msgOpen: flip(R().msgOpen, id) });
export const useOpenKey = (k: string) => useReply((s) => s.open.has(k));
export const toggleOpenKey = (k: string) => setR({ open: flip(R().open, k) });

// Whether a button went ahead; marking some as gone ahead, or not after all (its message didn't go).
export const useActed = (key: string) => useReply((s) => s.acted.has(key));
export const actedNow = (keys: string[]) => keys.some((k) => R().acted.has(k));
export function markActed(keys: string[], on: boolean) {
  const next = new Set(R().acted);
  for (const k of keys) {
    if (on) next.add(k);
    else next.delete(k);
  }
  setR({ acted: next });
}

// Whether a suggested reply of a message went; marking it gone, or not after all.
export const useQuickSent = (mid: string) => useReply((s) => s.quickSent.has(mid));
export const quickSentNow = (mid: string) => R().quickSent.has(mid);
export function markQuickSent(mid: string, on: boolean) {
  const next = new Set(R().quickSent);
  if (on) next.add(mid);
  else next.delete(mid);
  setR({ quickSent: next });
}

// On cards that go together: a card's button picked, or unpicked (picking the one picked); and forgetting the picks
// once they went.
const NO_PICKS: Record<number, number> = {};
export const useCardPicks = (mid: string) => useReply((s) => s.cardPick[mid] || NO_PICKS);
export function pickCard(mid: string, i: number, k: number) {
  const picks = { ...(R().cardPick[mid] || {}) };
  if (picks[i] === k) delete picks[i];
  else picks[i] = k;
  setR({ cardPick: { ...R().cardPick, [mid]: picks } });
}
export function forgetCardPicks(mid: string) {
  const { [mid]: _gone, ...rest } = R().cardPick;
  setR({ cardPick: rest });
}

export const useSlotPick = (mid: string) => useReply((s) => s.slotPick[mid]);
export const pickSlot = (mid: string, at: string) => setR({ slotPick: { ...R().slotPick, [mid]: R().slotPick[mid] === at ? undefined : at } });

// Where a before and after's handle is (50, the middle, until it's moved), and moving it.
export const useBaAt = (mid: string) => useReply((s) => s.baAt[mid] ?? 50);
export const setBaAt = (mid: string, x: number) => setR({ baAt: { ...R().baAt, [mid]: x } });
