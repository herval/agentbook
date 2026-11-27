import { taskNews } from "../groups.ts";
import { storedLevel } from "../visibility.ts";
import type { Logged, TaskOp, WorkspaceOp } from "../ops.ts";
import type { Iso, State, Task, TaskPage, TaskPost } from "../types.ts";
import { tick } from "./common.ts";

// A task's posts: any number of them, and a post can be on any number of tasks. Each link says when it was made
// and how: "sent" (the task went to the post's agent), "you" (linked from the page) or "agent" (from its post); and,
// from the page, who (`user`, an account's id: someone on a task shared with them).
export const linkPost = (t: Task, post: string | null | undefined, at: Iso, by: TaskPost["by"], user?: string | null): void => {
  if (post && !t.posts.some((e) => e.post === post)) t.posts.push({ post, at, by, ...(user ? { user } : {}) });
};

// A task's pages, as many as its threads: { page, at, by } each, `by` "you" or "agent" (a page's checklist an agent
// wrote). One from when a task had one `page` gets it as its first.
const taskPages = (t: Task): TaskPage[] => {
  if (!Array.isArray(t.pages)) t.pages = t.page ? [{ page: t.page, at: t.at, by: t.from ? "agent" : "you" }] : [];
  delete t.page;
  return t.pages;
};
const linkPage = (t: Task, page: string | null | undefined, at: Iso, by: TaskPage["by"]): void => {
  if (page && !taskPages(t).some((e) => e.page === page)) t.pages.push({ page, at, by });
};

export function applyWorkspace(state: State, op: WorkspaceOp, now: Iso): void {
  switch (op.t) {
    case "workspace.add": {
      // A repo (`repo`: its repoKey, `url`: what clones it) or a folder on a machine, or a repo with the
      // folders it's checked out in that a machine wouldn't find by itself. (An older one's `wip`, what its WIP
      // showed, its branches or its pull requests, is gone: it shows both.)
      state.workspaces[op.wid] = { id: op.wid, name: op.name, repo: op.repo || null, url: op.url || null, folders: op.folders || [], owner: op.owner || null, created: now, ...(storedLevel(op.visibility) === "public" ? { visibility: "public" as const } : {}) };
      break;
    }
    case "workspace.visibility": {
      // Who sees a workspace besides its owner (visibility.ts; private, the default, isn't kept), or with `branch`,
      // one of its worktrees (a branch, with its pull request): its own level, or null to go back to the workspace's.
      const w = state.workspaces[op.wid];
      if (!w) break;
      const level = storedLevel(op.visibility);
      if (op.branch) {
        const kept = { ...(w.worktrees || {}) };
        if (level) kept[op.branch] = level;
        else delete kept[op.branch];
        if (Object.keys(kept).length) w.worktrees = kept;
        else delete w.worktrees;
      } else if (level === "private") delete w.visibility;
      else if (level) w.visibility = level;
      break;
    }
    case "workspace.update": {
      const w = state.workspaces[op.wid];
      if (!w) break;
      if (op.name) w.name = op.name;
      if (op.folders) w.folders = op.folders;
      // Kept out of agent search.
      if (op.search_off === true) w.search_off = true;
      else if (op.search_off === false) delete w.search_off;
      break;
    }
    case "workspace.remove": {
      delete state.workspaces[op.wid];
      break;
    }
  }
}

export function applyTask(state: State, op: Logged<TaskOp>, now: Iso): void {
  switch (op.t) {
    case "task.add": {
      // One of your own tasks. `rank` orders your list, lowest first. Undoing a delete adds it back as it was.
      // `workspace` and `agent` are where and who it's for: sending it picks them in the composer. `source`: the
      // issue a connector brought it in from (connectors.ts). `posts`: the posts linked to it (linkPost). `from`:
      // the post of the agent that left it for you (ab_todo). One moved from before to-dos were tasks keeps
      // when it was `added` and done. `pages`: the pages it's on, as your page names them, any number, each
      // { page, at, by } (a page's checklist is its tasks; `page`, one, from before); `group`: the group it's in.
      // `text` is its title, one short line, and `note` its body, on why or how (titled() in text.ts). `answers`: the
      // buttons an agent's to-do offers (ab_todo), each a label and what pressing it sends as your message. `scope: "thread"`: a to-do its thread keeps for you, on that
      // thread and not on your Tasks, until task.scope moves it there; `later`: an agent's
      // to-do put on your Tasks on purpose (ab_todo's later, or moved there from its thread), which stays there.
      state.tasks[op.tid] = { id: op.tid, owner: op.owner, text: op.text, workspace: op.workspace || null, agent: op.agent || null, rank: op.rank ?? 0, at: op.added || now, done: !!op.done, done_at: op.done ? op.done_at || now : null, sent: op.sent || [], posts: [...(op.posts || [])], ...(op.from ? { from: op.from } : {}), ...(op.source ? { source: op.source } : {}), ...(Array.isArray(op.answers) && op.answers.length ? { answers: op.answers } : {}), pages: [], ...(op.group ? { group: op.group } : {}), ...(op.note ? { note: op.note } : {}), ...(op.scope === "thread" ? { scope: "thread" } : {}), ...(op.later && op.scope !== "thread" ? { later: true } : {}) };
      for (const e of state.tasks[op.tid].sent) linkPost(state.tasks[op.tid], e.post, e.at, "sent");
      for (const e of [...(op.pages || []), ...(op.page ? [op.page] : [])]) {
        const p: Partial<TaskPage> = typeof e === "string" ? { page: e } : e;
        linkPage(state.tasks[op.tid], p?.page, p?.at || now, p?.by || (op.from ? "agent" : "you"));
      }
      // In a group, its posts hear of it (not when Undo puts one back, nor a thread's own to-do).
      if (!op.done && !op.sent?.length && !op.scope) taskNews(state, state.tasks[op.tid], "added", op, now);
      break;
    }
    // A to-do onto its thread (scope "thread"), or onto your Tasks (scope null) from its thread.
    case "task.scope": {
      const t = state.tasks[op.tid];
      if (!t) break;
      // On its thread, it's in no group (the group's threads don't hear of it); on your Tasks, it stays there.
      if (op.scope === "thread") {
        t.scope = "thread";
        delete t.group;
        delete t.later;
      } else {
        delete t.scope;
        t.later = true;
      }
      break;
    }
    case "task.edit": {
      const t = state.tasks[op.tid];
      if (!t) break;
      if (op.text) t.text = op.text;
      if (op.workspace !== undefined) t.workspace = op.workspace;
      if (op.agent !== undefined) t.agent = op.agent;
      // From before a task had pages: the one it's on now.
      if (op.page !== undefined) {
        t.pages = op.page ? [{ page: op.page, at: now, by: "you" }] : [];
        delete t.page;
      }
      if (op.group !== undefined && (op.group || null) !== (t.group || null)) {
        t.group = op.group || null;
        if (!t.done) taskNews(state, t, "added", op, now);
      }
      if (op.note !== undefined) t.note = op.note || null;
      break;
    }
    case "task.done": {
      const t = state.tasks[op.tid];
      if (!t) break;
      const was = t.done;
      Object.assign(t, tick(op, now));
      if (was !== t.done) taskNews(state, t, t.done ? "done" : "undone", op, now);
      break;
    }
    case "task.sync": {
      // What a connector learned about a task's issue: its title (the task's text, unless you edited that
      // here, and what a long one puts in its note), its state, and whether it's done there. `done_by` tells a
      // task it ticked from one you ticked.
      const t = state.tasks[op.tid];
      if (!t) break;
      if (op.text) t.text = op.text;
      if (op.note !== undefined) t.note = op.note || null;
      if (op.source) t.source = { ...t.source, ...op.source };
      if (typeof op.done === "boolean" && op.done !== t.done) Object.assign(t, { done: op.done, done_at: op.done ? now : null, done_by: op.done ? "sync" : null, done_post: null });
      break;
    }
    case "task.move": {
      // Its owner's place for it on their list (`rank`), or, `user`, someone it's shared with's on theirs.
      const t = state.tasks[op.tid];
      if (!t) break;
      if (op.user && op.user !== t.owner) (t.ranks ||= {})[op.user] = op.rank;
      else t.rank = op.rank;
      break;
    }
    // Someone on a task besides its owner: `people`, their account ids, each on it since
    // `at`, added `by` (its owner's username), with their own place for it on their list (`ranks`); or taken off
    // (`remove`), as when they leave it.
    case "task.person": {
      const t = state.tasks[op.tid];
      if (!t || !op.user || op.user === t.owner) break;
      const people = t.people || [];
      if (op.remove) {
        t.people = people.filter((x) => x.user !== op.user);
        if (t.ranks) delete t.ranks[op.user];
      } else if (!people.some((x) => x.user === op.user)) {
        t.people = [...people, { user: op.user, at: now, by: op.by || null }];
        if (Number.isFinite(op.rank)) (t.ranks ||= {})[op.user] = op.rank;
      }
      if (!t.people.length) delete t.people;
      if (t.ranks && !Object.keys(t.ranks).length) delete t.ranks;
      break;
    }
    // Who sees a task besides its people: nobody (private, the default) or its owner's contacts (public); and whether
    // its people see its threads' steps and changes (`show_work`, on unless turned off).
    case "task.visibility": {
      const t = state.tasks[op.tid];
      if (!t) break;
      if (op.visibility) {
        if (storedLevel(op.visibility) === "public") t.visibility = "public";
        else delete t.visibility;
      }
      if (typeof op.show_work === "boolean") {
        if (op.show_work) delete t.show_work;
        else t.show_work = false;
      }
      break;
    }
    case "task.remove": {
      // A task from a connector stays, out of sight, so the next sync doesn't bring its issue back.
      const t = state.tasks[op.tid];
      if (t?.source && !op.forget) t.removed = now;
      else delete state.tasks[op.tid];
      break;
    }
    case "task.restore": {
      if (state.tasks[op.tid]) state.tasks[op.tid].removed = null;
      break;
    }
    case "task.send": {
      // Sent to an agent: the session its launch starts is the task's. It may have started already.
      const t = state.tasks[op.tid];
      if (!t) break;
      t.sent.push({ launch: op.launch, agent: op.agent || null, post: state.launches[op.launch]?.post || null, at: now, ...(op.user ? { user: op.user } : {}) });
      linkPost(t, t.sent.at(-1).post, now, "sent");
      break;
    }
    case "task.linked": {
      // A session on another machine, which this one hears of from the hub.
      const e = state.tasks[op.tid]?.sent.find((x) => x.launch === op.launch);
      if (!e) break;
      e.post = op.post;
      linkPost(state.tasks[op.tid], op.post, now, "sent");
      break;
    }
    case "task.page": {
      // A page linked to a task, or unlinked (`linked: false`); with no page, one from before gets its `pages`.
      const t = state.tasks[op.tid];
      if (!t) break;
      taskPages(t);
      if (!op.page) break;
      if (op.linked === false) t.pages = t.pages.filter((e) => e.page !== op.page);
      else linkPage(t, op.page, now, op.by === "agent" ? "agent" : "you");
      break;
    }
    case "task.link": {
      // A post linked to a task, or unlinked (`linked: false`), by the person or by an agent from its post.
      const t = state.tasks[op.tid];
      if (!t) break;
      if (op.linked === false) t.posts = t.posts.filter((e) => e.post !== op.post);
      else linkPost(t, op.post, now, op.by ? "agent" : "you", op.user);
      break;
    }
    case "wip.moved": {
      // A WIP of many from before tasks held pull requests: its task has what it had
      // (`task`), or, one agentbook made for a thread, it's put away. Nothing else reads them.
      const w = state.wip_sets?.[op.sid];
      if (!w) break;
      w.archived ||= now;
      w.moved = op.task || null;
      break;
    }
  }
}
