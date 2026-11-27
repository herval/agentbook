// What ./api/people-spaces.ts says, for the routes that load before it: someone on another agentbook put in a group,
// task, page or note of yours is asked first; an agent's page tools reach the pages elsewhere its person contributes
// to. Until it's loaded, nobody is elsewhere.
import type { User } from "../accounts.ts";
import type { Asker } from "./types.ts";

type Answer = Record<string, unknown> & { error?: string; status?: number };
export const elsewhere = {
  // Someone put in (`remove`: taken out of) `space` (group:<id>, task:<id>, page:<id>, note:<id>), named `name`: what
  // to answer instead of doing it (they're asked, or the ask is taken back, or why not), or null for someone here.
  ask: (_space: string, _name: string, _uid: string, _remove: boolean): Answer | null => null,
  pages: (_o: User): Record<string, unknown>[] => [],
  readPage: (_o: User, _id: string): Answer | null => null,
  writePage: (_o: User, _me: Asker, _b: Record<string, unknown>): Answer | null => null,
};
// Whether a page id an agent gives names one elsewhere: "@alice/ledger".
export const isElsewhere = (id: unknown) => typeof id === "string" && id.startsWith("@");
