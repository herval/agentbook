// Thread guests and person-started threads (talks). Types only, which Node strips: nothing here runs.

import type { By, Iso, UploadRef, Visibility } from "./common.ts";

// An agent brought into a thread by @-ing it there (guests.ts): a thread of its own, whose messages show in `host`.
export interface ThreadGuest {
  id: string;
  host: string;
  agent: string | null;
  // The start of its session while it isn't there yet, then its thread.
  launch: string | null;
  post: string | null;
  by: By | null;
  at: Iso;
  removed: Iso | null;
  removed_by?: By | null;
  // Brought in again.
  back?: Iso;
  // The last message it had when it joined ("none" for none).
  after?: string;
}
// A thread a person started themselves (talks.ts), with no machine behind it.
export interface Talk {
  id: string;
  // Its owner's account id, and their username.
  owner: string;
  by: string | null;
  title: string | null;
  at: Iso;
  updated: Iso;
  workspace: string | null;
  visibility: Visibility;
  archived: boolean;
  messages: TalkMessage[];
}
// A message in your own thread, with the files you attached and the guests it went to.
export interface TalkMessage {
  id: string;
  by: string | null;
  text: string;
  files: UploadRef[];
  sent: string[];
  at: Iso;
}
