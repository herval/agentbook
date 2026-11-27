// Shared primitives used across a store's state types. Types only, which Node strips: nothing here runs.

// A time, as an ISO string (Date's toISOString).
export type Iso = string;
// Who sees a thing besides its owner and the people they put on it (visibility.ts): public is their contacts.
export type Visibility = "private" | "public";
// Who did something: an agent from one of its threads ({ agent, post }), a routine's run ({ agent, routine }), a
// person ({ user }: their username), or something on a machine that couldn't be tied to a thread ({ machine }).
export interface By {
  agent?: string;
  post?: string;
  routine?: string;
  user?: string | null;
  machine?: string;
  // With `user`, someone on another agentbook: their agent that wrote it, by its name ("@bob's Claude").
  as?: string;
}
// A routine's run, on what it started (a launch, a message): the routine, by its id and name (routines.ts).
export interface RoutineRef {
  id: string;
  name: string;
  why?: string;
}
// Who ticked something off: "you", an agent from its thread, or a connector's sync.
export type DoneBy = "you" | "agent" | "sync";
// A file someone uploaded, as machines fetch it.
export interface UploadRef {
  id: string;
  name: string;
  size: number;
  sha: string;
  type?: string;
}
