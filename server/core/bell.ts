// More lines for a person's bell (api/views.ts's addedFor), from parts that keep their own: someone elsewhere naming
// you in what they publish (api/people-things.ts). Each source gives its lines since `since`, as addedFor's are.
import type { User } from "../accounts.ts";

export interface BellExtra {
  kind: string;
  id: string;
  title: string;
  emoji: string | null;
  by: string | null;
  at: string;
  text?: string;
  link?: string;
}
export const bellSources: ((u: User, since: number) => BellExtra[])[] = [];
