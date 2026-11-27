// Why a thread may not run in Full access, as other parts say: in a group or on a task with someone on another
// agentbook, whose text reaches it (./api/people-spaces.ts). Null when it may.
export type Where = { post?: string | null; group?: string | null; task?: string | null };
export const fullAccessGuards: ((w: Where) => string | null)[] = [];
export function noFullAccess(w: Where): string | null {
  for (const g of fullAccessGuards) {
    const why = g(w);
    if (why) return why;
  }
  return null;
}
