// The pieces of a thread's card that the thread area draws (old postCard's updatesList, prCards, threadTodos,
// attachment, filesRow, summary, actions), as it registers them (thread/card-parts.tsx). ThreadCard now imports them
// itself; this registry is kept so what registers here still loads.
import type { ComponentType } from "react";
import type { Thread } from "../../lib/types.ts";

export interface CardParts {
  // What it said it did (ab_update), its pull requests, the to-dos it keeps, what it attached (ab_attach), its files.
  Updates?: ComponentType<{ thread: Thread }>;
  PrCards?: ComponentType<{ thread: Thread; feed?: boolean }>;
  Todos?: ComponentType<{ thread: Thread; card?: boolean }>;
  Attachments?: ComponentType<{ thread: Thread }>;
  Files?: ComponentType<{ thread: Thread }>;
  // What its turn ended with, and the buttons under it.
  Summary?: ComponentType<{ thread: Thread }>;
  Actions?: ComponentType<{ thread: Thread }>;
}
// What a branch chip says of a thread's worktree: where it goes, where it stands (wipWhy), and what isn't on main yet.
export interface BranchWip {
  href: string;
  why: string;
  kind: "pr" | "branch";
  // A pull request's: "merged", "closed" or open, and what its chip says of it (prMeta).
  prState?: string;
  prMeta?: string;
  dirty?: number;
  ahead?: number;
  worked?: boolean;
}
export const cardParts: CardParts = {};
// An area adds its pieces.
export function registerCardParts(parts: CardParts) {
  Object.assign(cardParts, parts);
}
