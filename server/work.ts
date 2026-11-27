// A post's work, kept on the server as its machine sends it (post.steps, post.images, post.changes): its steps
// and plan, the pictures its agent saw (their bytes are blobs), and what it changed, by scope ("all", a turn, a
// step: "s:<id>"). So a post's page is whole while its machine is off. Kept under the machine's store's scope (its
// rows in storage.db, next to the rest of what the server keeps of it), and read on demand rather than held in memory. And the pictures
// on its machine its agent names by their paths (post.picture), as its machine read them, or why it couldn't:
// `onPicture(D, op)` hears of each.

import { WorkTables } from "../plugin/shared/storage/work.ts";
import type { ChangedFile } from "../plugin/shared/diff.ts";
import type { Iso } from "../plugin/shared/types.ts";
import type { PictureKept, StepImage, WorkOp } from "../plugin/shared/ops.ts";
import type { Device } from "./relay.ts";

// A step as its machine sent it (plugin/cli/drivers/steps.ts's Step): something it said ("say"), or a tool it used.
export interface SentStep {
  id: string;
  kind: string;
  title?: string;
  turn?: number;
  at?: Iso | null;
}
// What a post changed in a scope, as its machine sent it: each file it changed with its hunks (diff.ts's capped:
// `more`, the lines left out), their totals, and its commits. A step's scope ("s:<id>") has only its files.
export interface ScopeChanges {
  files: (Omit<ChangedFile, "abs"> & { more?: number })[];
  totals?: { files: number; add: number; del: number };
  commits?: unknown[];
}
// Its changes in brief (the "meta" scope): its latest turn, whether that turn changed anything, and how many turns did.
export interface ChangesMeta {
  latest: number;
  latest_has: boolean;
  turns: number;
}

// A post's work as its machine sent it (ops.ts's WorkOp), and when.
export type WorkSent = WorkOp & { at?: Iso };
export type PictureOp = Extract<WorkSent, { t: "post.picture" }>;
// A post's plan and turn, as kept with its steps.
interface PlanKept {
  plan: unknown;
  turn: number;
}

export type Work = ReturnType<typeof createWork>;
export function createWork({ onPicture = () => {} }: { onPicture?: (D: Device, op: PictureOp) => void } = {}) {
  // A machine's work tables (plugin/shared/storage/work.ts), under its store's scope: one per store.
  const of = new WeakMap<object, WorkTables>();
  const tables = (D: Device): WorkTables => {
    let t = of.get(D.store);
    if (!t) of.set(D.store, (t = D.store.storage.use(WorkTables, D.store.scope)));
    return t;
  };

  // How many times each post's work changed since the server started, by machine and post: what's made from it is the
  // same until this moves. Not the times its ops carry: two of them can come in the same millisecond.
  const changed = new Map<string, number>();
  // An op with a post's work, from its machine.
  function apply(D: Device, op: WorkSent): void {
    const t = tables(D);
    const at = op.at || new Date().toISOString();
    changed.set(`${D.id}\n${op.post}`, (changed.get(`${D.id}\n${op.post}`) || 0) + 1);
    if (op.t === "post.steps") {
      t.saveSteps(op.post, { from: Math.max(0, Number(op.from) || 0), total: Number(op.total) || 0, steps: op.steps || [], plan: op.plan ?? null, turn: op.turn ?? 0 }, at);
    } else if (op.t === "post.images") {
      t.saveWork(op.post, `images:${op.step}`, op.images || [], at);
    } else if (op.t === "post.picture") {
      const kept = op.sha ? { sha: op.sha, type: op.type || null, size: op.size || 0 } : { status: op.status || 404, error: op.error || null };
      t.saveWork(op.post, `picture:${op.url}`, kept, at);
    } else if (op.t === "post.changes") {
      t.saveWork(op.post, `changes:${op.scope}`, op.data ?? null, at);
    }
    if (op.t === "post.picture") onPicture(D, op);
  }

  const get = (D: Device, post: string, key: string) => tables(D).work(post, key);
  // Its steps, plan and turn, or null when its machine hasn't sent them.
  function steps(D: Device, post: string): { steps: SentStep[]; plan: unknown; turn: number } | null {
    const plan = get(D, post, "plan") as { data: PlanKept } | null;
    if (!plan) return null;
    return { steps: tables(D).steps(post) as SentStep[], plan: plan.data.plan, turn: plan.data.turn };
  }
  // A picture its agent saw on a step: { sha, type, size }, or null.
  const image = (D: Device, post: string, step: string, i: number): StepImage | null => (get(D, post, `images:${step}`)?.data as StepImage[] | undefined)?.[i] || null;
  // A picture its agent named by its path: { sha, type, size }, or { status, error } for why its machine couldn't
  // send it, or null when it hasn't said.
  const picture = (D: Device, post: string, url: string): PictureKept | null => (get(D, post, `picture:${url}`)?.data as PictureKept | undefined) || null;
  // What it changed in a scope, or null.
  function changes(D: Device, post: string, scope: "meta"): ChangesMeta | null;
  function changes(D: Device, post: string, scope: string): ScopeChanges | null;
  function changes(D: Device, post: string, scope: string): ChangesMeta | ScopeChanges | null {
    return (get(D, post, `changes:${scope}`)?.data as ChangesMeta | ScopeChanges | undefined) ?? null;
  }
  // When its steps, plan or changes last came, or null.
  const version = (D: Device, post: string): number => changed.get(`${D.id}\n${post}`) || 0;
  // Every blob a machine's work names (to keep when cleaning up).
  const blobsOf = (D: Device): string[] => [...(tables(D).workWith("images:") as StepImage[][]).flatMap((list) => list.map((x) => x.sha)), ...(tables(D).workWith("picture:") as PictureKept[]).map((p) => p.sha).filter(Boolean)];
  return { apply, steps, image, picture, changes, version, blobsOf };
}
