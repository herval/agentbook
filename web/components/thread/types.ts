// What the thread's page reads of a thread and its messages beyond what lib/types.ts says of them: what the server
// adds for the page (server/feed.ts's view of a thread) that the shared types don't name.
import type { Message, Thread } from "../../lib/types.ts";

// Something it left running after its turn, and a thread with those (lib/types.ts has both now).
export type { Going } from "../../lib/types.ts";
export type ThreadX = Thread;
// A message, with what a thread's conversation adds to one: the guest it's from or to, the agent that wrote it, and
// in a thread of yours, who it was to.
export type SaidMsg = Message & { guest?: string | null; agent?: string | null; to?: string[] | null };
export const x = (s: Thread): ThreadX => s as ThreadX;
