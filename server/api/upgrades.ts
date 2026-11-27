// What's moved once from how the server kept things before, as it starts: main.ts loads this last, once every area
// it reads is loaded.

import type { ShipEvent, ShipItem } from "../../plugin/shared/types.ts";
import { commit, log, state } from "../core/state.ts";
import { openTasks, pagesOfTask, rankFor, taskId } from "./tasks.ts";
import { groupOwner } from "./groups.ts";
import { aLine } from "./task-ship.ts";

// The WIPs of many from before (wip-sets.mjs, gone): each one someone made is a task now, on top of their list, with
// what it had (what was put in it, its threads, how its pull requests stood, what happened to it, its landing order),
// in the group most of its threads are in; the ones agentbook made for a thread are put away, their threads as they
// were. Once: each is marked moved.
for (const w of Object.values(state.wip_sets || {})) {
  if (w.moved !== undefined) continue;
  if (w.archived || w.for || !w.owner) {
    commit({ t: "wip.moved", sid: w.id });
    continue;
  }
  const posts = Object.entries(w.posts || {}).map(([post, v]) => ({ post, at: v?.at || w.created, by: "you" as const }));
  const count = new Map();
  for (const e of posts) {
    const gid = state.group_posts[e.post]?.group;
    if (gid && groupOwner(state.groups[gid]) === w.owner) count.set(gid, (count.get(gid) || 0) + 1);
  }
  const [group, n] = [...count].sort((a, b) => b[1] - a[1])[0] || [];
  const open = openTasks(w.owner);
  const tid = taskId();
  commit({ t: "task.add", tid, owner: w.owner, text: aLine(w.title, 80) || "Ship it", note: w.note || undefined, rank: open.length ? rankFor(open[0], w.owner) - 1 : 0, posts, added: w.created, ...(group && n * 2 >= posts.length ? { group } : {}) });
  commit({ t: "task.ship", tid, ship: { items: (w.items || []) as ShipItem[], prs: w.prs || {}, events: (w.events || []).filter((e) => e.kind === "pr" || e.kind === "order" || e.kind === "landing" || e.kind === "asked") as ShipEvent[], seen: w.seen || {}, order: w.order || null, landing: w.landing || null, since: w.created } });
  commit({ t: "wip.moved", sid: w.id, task: tid });
  log(`The WIP "${w.title}" (${w.id}) is the task ${tid} now.`);
}
// Agents' to-dos from before a thread kept its own: each open one an agent left with ab_todo goes on its thread, as one
// it leaves now would, and out of any group. Not a page's checklist (`page`), nor one on your Tasks on purpose
// (`later`).
{
  const moving = Object.values(state.tasks).filter((t) => t.from && !pagesOfTask(t).length && !t.source && !t.scope && !t.later && !t.done && !t.removed);
  for (const t of moving) commit({ t: "task.scope", tid: t.id, scope: "thread" });
  if (moving.length) log(`Moved ${moving.length} agents' to-dos from Tasks onto their threads.`);
}
