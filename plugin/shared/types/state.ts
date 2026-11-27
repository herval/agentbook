// The top-level store state shape and cold-history interface. Types only, which Node strips: nothing here runs.

import type { FeedSummary, FileRecord, HistoryPart, Launch, Message, OutboxEntry, Question, Todo } from "./activity.ts";
import type { Agent } from "./agents.ts";
import type { Iso } from "./common.ts";
import type { Group, GroupEvent, GroupFile, GroupNote, GroupPost } from "./groups.ts";
import type { Talk, ThreadGuest } from "./guests.ts";
import type { Note, NoteVersion } from "./notes.ts";
import type { Page, PagePost, PageVersion } from "./pages.ts";
import type { Routine, RoutineCode, RoutineRun, RoutineThread } from "./routines.ts";
import type { AgentFollows, AutoArchived, Box, Contact, FeedArchived, Image, ImageBuild, MachineCloud, NewsItem, PersonFollow, Prefs, ThreadPeople } from "./server.ts";
import type { Task, WipSet, Workspace } from "./tasks.ts";
import type { Session } from "./threads.ts";

// A store's state. Maps are by id; lists are in order, oldest first unless said. The parts marked "server only" are
// made by the first op that needs them, on agentbook-server's own store.
export interface State {
  // The last op applied.
  seq: number;
  agents: Record<string, Agent>;
  // Threads, by the page's id for them (Claude Code's session id, or its process before it has one).
  sessions: Record<string, Session>;
  // Each running process's thread: process -> thread id.
  procs: Record<string, string>;
  launches: Record<string, Launch>;
  questions: Question[];
  // Agents' to-dos from before they were tasks: replayed from old logs, then moved.
  todos: Todo[];
  // Newest first.
  files: FileRecord[];
  messages: Message[];
  outbox: OutboxEntry[];
  workspaces: Record<string, Workspace>;
  tasks: Record<string, Task>;
  pages: Record<string, Page>;
  page_versions: PageVersion[];
  routines: Record<string, Routine>;
  routine_code: RoutineCode[];
  routine_runs: RoutineRun[];
  groups: Record<string, Group>;
  group_notes: GroupNote[];
  group_files: GroupFile[];
  group_events: GroupEvent[];
  // The group each thread is in, by thread.
  group_posts: Record<string, GroupPost>;
  notes: Record<string, Note>;
  note_versions: NoteVersion[];
  thread_guests: Record<string, ThreadGuest>;
  // How far each thread has heard its guests' messages: thread -> the time it heard up to.
  thread_seen: Record<string, Iso>;
  talks: Record<string, Talk>;
  // The WIPs of many from before tasks held pull requests: read once, to move them onto tasks.
  wip_sets: Record<string, WipSet>;
  // The page each thread's person put it on by hand, by thread.
  page_posts: Record<string, PagePost>;
  // By `${agent}|${user}`, and "seeded" once follows.seed ran.
  agent_follows: AgentFollows;
  // By `${person}|${user}`.
  person_follows: Record<string, PersonFollow>;
  // By the two people's account ids in order, `${a}|${b}`.
  contacts: Record<string, Contact>;
  // The people on a thread besides its owner, by the page's id of the thread.
  thread_people: Record<string, ThreadPeople>;
  // A person's archived page updates, by their account id.
  feed_archived: Record<string, FeedArchived>;
  // The cloud sandbox each machine runs in, by machine (device id). Server only.
  machine_cloud: Record<string, MachineCloud>;
  images: Record<string, Image>;
  image_builds: Record<string, ImageBuild>;
  // Shared machines, by machine. Server only.
  boxes: Record<string, Box>;

  // When each person last opened the bell, by account id. Server only.
  bell_seen?: Record<string, Iso>;
  // When each person last cleared the bell, by account id. Server only.
  bell_cleared?: Record<string, Iso>;
  // Lines each person took off the bell: account id -> line key -> when what they dismissed happened (or ""). Server only.
  bell_dismissed?: Record<string, Record<string, string>>;
  // Threads started on a routine from its page, by routine key, newest 20. Server only.
  routine_threads?: Record<string, RoutineThread[]>;
  // Each person's settings, by account id. Server only.
  prefs?: Record<string, Prefs>;
  // Threads Auto-archive archived, by thread. Server only.
  auto_archived?: Record<string, AutoArchived>;
  // News for each person's bell, by account id, newest 50. Server only.
  news?: Record<string, NewsItem[]>;
  // Threads off every list while their person has Private terminals on: thread -> account id. Server only.
  private_off?: Record<string, string>;
  // Launches that started a thread in a group, which joined it once. Server only.
  group_launched?: Record<string, true>;

  // What reads a thread's history when memory may not hold it (store.ts's warm); not saved with the state.
  readonly cold?: ColdHistory;
}

// What reads threads whose history is out of memory (store.ts).
export interface ColdHistory {
  has(post: string): boolean;
  summary(post: string): FeedSummary | undefined;
  warm(post: string): void;
  file(fid: string): void;
  rows<P extends HistoryPart>(part: P, posts?: Set<string> | null): State[P];
  row<P extends HistoryPart>(part: P, id: string): State[P][number] | null;
  messagesChunk(afterOrd: number, limit: number): { ord: number; post: string | null; item: Message }[];
}
