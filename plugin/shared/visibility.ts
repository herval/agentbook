// Who sees a thing. A thread, an agent, a page, a group, a task, a note, a workspace and a
// worktree are public (their owner's contacts see it) or private (only their owner); either way, the people their
// owner put on it see it too (a task's, a group's, a page's, a note's, a thread's people).
// Before two levels there was "followers" (the people who follow the agents in it), each of them someone its owner
// had said yes to: it reads as public. Nothing stored is rewritten, as a thread's level lives on its machine too.

import type { Visibility } from "./types.ts";

export const LEVELS: Visibility[] = ["private", "public"];
export const isLevel = (v: unknown): v is Visibility => (LEVELS as readonly unknown[]).includes(v);
// A stored level as it reads now, or null when it isn't one.
export const storedLevel = (v: unknown): Visibility | null => (v === "followers" ? "public" : isLevel(v) ? v : null);
// A level from what someone sent or what's stored, or `fallback` when it isn't one.
export const levelOf = (v: unknown, fallback: Visibility = "private"): Visibility => storedLevel(v) ?? fallback;
