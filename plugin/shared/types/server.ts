// Follows and server-only store records (prefs, bell news, cloud sandboxes, images, shared machines). Types only.

import type { Iso } from "./common.ts";
import type { VerdictKind } from "./shapes.ts";
import type { PrLineKind } from "./threads.ts";

/* ---------- follows ---------- */

// Following is your feed only: nobody asks, nobody's told, and it lets nobody see anything.
// An agent whose threads you have in your feed, or (`off`) one you turned off while you follow its owner.
export interface AgentFollow {
  agent: string;
  user: string;
  at: Iso;
  off?: true;
}
// What follows.seed left, under the key "seeded", from before follows were your feed only.
export interface FollowsSeeded {
  at: Iso;
}
export type AgentFollows = Record<string, AgentFollow> & { seeded?: FollowsSeeded };
// A person whose things you have in your feed: a contact of yours.
export interface PersonFollow {
  person: string;
  user: string;
  at: Iso;
}
// Two people who are each other's contact (`at`: since when), or one asking the other to be (`ask`: who asks, since
// `ask_at`), by the two account ids in order (`a` < `b`): each sees what the other made public.
export interface Contact {
  a: string;
  b: string;
  at?: Iso;
  ask?: string;
  ask_at?: Iso;
  // What they said with their ask.
  note?: string;
  // Once they're contacts: who asked.
  by?: string;
}
// The people a thread's owner put on it: they see it, and its work, while it's private too.
export interface ThreadPeople {
  post: string;
  people: { user: string; by: string | null; at: Iso }[];
}
// A person's page updates archived off their feed: page -> when it last moved up the feed then (or "").
export type FeedArchived = Record<string, string>;

/* ---------- the server's own ---------- */

// A person's settings: Auto-archive and Private terminals, and since when each is on.
export interface Prefs {
  auto_archive?: boolean;
  auto_archive_at?: Iso;
  private_terminals?: boolean;
  private_terminals_at?: Iso;
}
// A thread Auto-archive archived. `skipped`: one done already when it was turned on, left as it was.
export interface AutoArchived {
  user: string;
  at: Iso;
  why: string | null;
  title: string | null;
  skipped?: true;
}
// News for a person's bell (server/news.ts): a long turn ended, a pull request's line, or a result its agent flagged.
// `key` says what it's about, so it's said once.
export interface NewsItem {
  kind: "turn" | "pr" | "flag";
  post: string;
  text: string;
  at: Iso;
  key?: string;
  verdict?: VerdictKind | null;
  mins?: number;
  pr?: { url: string; number: number | null; kind: PrLineKind };
  link?: string | null;
}
// The cloud sandbox a machine runs in: which connector of its owner's wakes it (boat's, or exe.dev's), and which
// sandbox. One agentbook made on boat (`made`) has the image it came from and the boat environment for its secrets
// (their names only).
export interface MachineCloud {
  connector: string;
  sandbox: string;
  at: Iso;
  // Which provider it runs on, by its connector's kind: "exe" (exe.dev), or boat when it has none.
  kind?: string;
  // An exe.dev machine agentbook made, waiting for its person to say yes to its code on the relay's page (`code`,
  // `url`), as `agentbook login` printed it there.
  login?: { code: string; url: string; at: Iso } | null;
  // Whether git there signs in to GitHub as its owner (on unless turned off).
  github?: boolean;
  made?: true;
  image?: string | null;
  v?: number | null;
  size?: string | null;
  env?: string | null;
  env_name?: string | null;
  secrets?: string[];
  // Its setup is running, or failed; an update to this image version is running; boat no longer has it.
  setting?: true;
  setup_error?: string;
  updating?: number;
  gone?: true;
}
// What a cloud machine of its owner's starts with, as a draft they edit; building it makes a version.
export interface Image {
  id: string;
  owner: string;
  connector: string | null;
  name: string;
  def: ImageDef;
  // Its newest version built, or being built.
  v: number;
  created: Iso;
  updated: Iso;
}
// An image's picks, repos, steps and settings, with secrets as names only (server/image-script.ts).
export interface ImageDef {
  size: string;
  agents: string[];
  picks: string[];
  apt: string[];
  npm: string[];
  uv: string[];
  repos: { repo: string; branch?: string; install?: string }[];
  steps: string;
  env: Record<string, string>;
  secrets: string[];
  // How Claude Code signs in there.
  claude: "token" | "signin";
}
// One version of an image being made into a disk on a builder sandbox, with the definition it was built from.
export interface ImageBuild {
  id: string;
  image: string;
  v: number;
  owner: string;
  connector: string | null;
  def: ImageDef;
  // The agentbook-cli version in it, and boat's saved snapshot and builder sandbox.
  cli: string | null;
  snapshot: string | null;
  sandbox: string | null;
  state: "building" | "saving" | "ready" | "failed" | "gone";
  started: Iso;
  ended: Iso | null;
  error: string | null;
  log: string;
  // The step its script is on.
  step?: string | null;
}
// A shared machine: its owner, and who's on it, by account id.
export interface Box {
  id: string;
  owner: string | null;
  members: Record<string, BoxMember>;
}
// Someone on a shared machine: invited (their seat is made there once `seated`), then joined from their own machine
// (`device`).
export interface BoxMember {
  user: string;
  state: "invited" | "joined";
  seated: boolean;
  device: string | null;
  at: Iso;
  joined?: Iso;
}
