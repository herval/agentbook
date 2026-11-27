// The types of a store's state: what createStore (store.ts) keeps in `store.state`, part by part, and the records in
// each. Split by area under ./types/ and re-exported here so existing imports keep working. Types only, which Node
// strips: nothing here runs. A field is optional (`?`) when records can lack it, from before the code set it or
// because only some ops set it; `null` is what the code writes for "none".

export type * from "./types/common.ts";
export type * from "./types/state.ts";
export type * from "./types/agents.ts";
export type * from "./types/threads.ts";
export type * from "./types/shapes.ts";
export type * from "./types/activity.ts";
export type * from "./types/tasks.ts";
export type * from "./types/pages.ts";
export type * from "./types/widgets.ts";
export type * from "./types/routines.ts";
export type * from "./types/groups.ts";
export type * from "./types/notes.ts";
export type * from "./types/guests.ts";
export type * from "./types/server.ts";
