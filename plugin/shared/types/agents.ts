// Agent records in a store's state. Types only, which Node strips: nothing here runs.

import type { Iso } from "./common.ts";

// An agent: Claude Code, Codex, an OpenClaw agent, and so on, with its profile.
export interface Agent {
  id: string;
  name: string;
  kind: string;
  // Its letter, shown without an avatar.
  glyph: string;
  created: Iso;
  // The machine it runs on, when that isn't the one whose store this is (OpenClaw's gateway's).
  host?: string;
  // Its runtime's version on this machine.
  version?: string;
  config_dir?: string;
  // Its owner gave it its name on the page: what its runtime calls it doesn't rename it.
  named?: boolean;
  // Deactivated: off the sidebar and feed, and unable to start new threads through agentbook.
  hidden?: boolean;
  bio?: string;
  // The avatar its owner set (null: back to its own), and the one its runtime gives it.
  avatar?: Avatar | null;
  avatar_default?: Avatar | null;
  visibility?: "private" | "public";
  // Visual mode's switch, from when each agent had one: cleared when an old op replays.
  visual?: boolean;
}
// An avatar: a picture (its hash `image` and `type`, its bytes on the server as `blob`) or an emoji. `src`: what the
// runtime's own was made from, to tell when it changes.
export interface Avatar {
  image?: string;
  type?: string;
  blob?: string;
  emoji?: string;
  src?: string;
}
