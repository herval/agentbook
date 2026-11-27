#!/usr/bin/env node
// ⌘K's list (web/lib/goto.ts): what a name typed finds, best first. Every word typed has to be in a place's name
// or in what else it goes by; a name that's all of what's typed comes first, then what's going or open, what's
// landed, and what's put away last; then what has it all in its name; then threads and routines, pages, groups and
// WIP, tasks, worktrees; then what's working before what's open, the start of a word more than its middle, and the
// newer first; a word no place has as typed is taken as a typo.
// Run: node test/goto.ts

import { KIND, marked, RANK, rankPlaces } from "../web/lib/goto.ts";
import type { Place } from "../web/lib/goto.ts";

let failures = 0;
const check = (cond: unknown, label: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const keys = (q: string, places: (Place & { key: string })[]) => rankPlaces(places, q).list.map((p) => p.key);

const places = [
  { key: "screen:pages", name: "Pages", more: "dashboards" },
  { key: "page:rel", name: "Reliability", more: "@herval · erp-sync uptime", at: "2026-10-16" },
  { key: "page:old", name: "Reliability, before", more: "", rank: RANK.away, at: "2026-10-17" },
  { key: "thread:petrel", name: "Add a search to the feed", more: "petrel · Claude @ hervalm5 · agentbook", at: "2026-10-15" },
  { key: "thread:quail", name: "Pack the runner", more: "quail · Codex · platform", at: "2026-10-17" },
  { key: "group:launch", name: "agentbook 0.5", more: "Ship the next release" },
  { key: "person:dove", name: "Dove Martín", more: "@dove" },
  { key: "workspace:ab", name: "agentbook", more: "github.com/herval/agentbook" },
];

check(rankPlaces(places, "").list.length === 0 && rankPlaces(places, "   ").list.length === 0, "nothing typed finds nothing");
check(keys("reli", places)[0] === "page:rel" && keys("reli", places)[1] === "page:old", "the archived one goes after, though it's newer");
check(keys("pages", places)[0] === "screen:pages", "a name that's all of what's typed is first: Pages, the screen");
check(keys("agentbook", places)[0] === "workspace:ab" && keys("agentbook", places).includes("thread:petrel") && keys("agentbook", places).includes("group:launch"), "agentbook: the workspace by that name first, then what's in it or named for it");
check(keys("petrel", places)[0] === "thread:petrel", "a thread by its label, though its name is its title");
check(keys("search feed", places).join() === "thread:petrel", "every word has to be in it, in any order");
check(keys("search quail", places).length === 0, "a word in one place and a word in another find neither");
check(keys("martin", places)[0] === "person:dove", "accents don't count: martin finds Martín");
check(keys("@dove", places)[0] === "person:dove", "a person by their @username");
check(keys("relaibility", places)[0] === "page:rel", "a typo still finds it (relaibility)");
check(keys("runer", places)[0] === "thread:quail", "a letter missing still finds it (runer)");
check(keys("run", places).join() === "thread:quail", "a word found as typed isn't taken as a typo of another");
check(keys("ship", places)[0] === "group:launch", "what else it goes by finds it too: a group by its brief");
// The name counts more than the rest: "uptime" is only in Reliability's line; "Pack" is in a name.
const tie = [
  { key: "a", name: "Runner notes", more: "pack" },
  { key: "b", name: "Pack the runner", more: "" },
];
check(keys("pack", tie)[0] === "b", "in its name beats in what else it goes by");
const words = [
  { key: "mid", name: "Unpacked", more: "" },
  { key: "start", name: "The packing list", more: "" },
];
check(keys("pack", words)[0] === "start", "the start of a word beats its middle");
const ties = [
  { key: "old", name: "Standup notes", at: "2026-10-01" },
  { key: "new", name: "Standup notes", at: "2026-10-17" },
  { key: "gone", name: "Standup notes", at: "2026-10-18", rank: RANK.away },
];
check(keys("standup", ties).join() === "new,old,gone", "as good: the newer first, what's archived last");

// How it's going counts before how well the name fits (herval's ⌘K for "openclaw": archived threads and landed
// WIP whose titles start with OpenClaw came before the thread working on it now).
const going = [
  { key: "archived", name: "OpenClaw agents show no skills", at: "2026-10-22", rank: RANK.away },
  { key: "landed", name: "OpenClaw replies show their files", at: "2026-10-22", rank: RANK.landed },
  { key: "idle", name: "OpenClaw workspace files", at: "2026-10-20" },
  { key: "live", name: "Give OpenClaw agents ab_* tools", at: "2026-10-23", rank: RANK.going },
  { key: "older", name: "Pair agentbook with OpenClaw", at: "2026-10-19" },
];
check(keys("openclaw", going).join() === "live,idle,older,landed,archived", "working first, then open (the newer first), landed, archived");
const exact = [
  { key: "live", name: "Notes on the notes", at: "2026-10-23", rank: RANK.going },
  { key: "screen", name: "Notes" },
];
check(keys("notes", exact)[0] === "screen", "a name that's all of what's typed still comes first: Notes, the screen");

// Threads and routines first, then pages, groups and WIP, then tasks, then worktrees, whatever's working: a worktree
// being reviewed and a task that needs you go after an idle thread.
const kinds = [
  { key: "worktree", kind: "Worktree", name: "feat(iac/hive-prodbr): add an isolated GCP project for Hive", at: "2026-10-30", rank: RANK.going },
  { key: "task", kind: "Task", name: "Review the Hive prod stack", at: "2026-10-30", rank: RANK.going },
  { key: "wip", kind: "WIP", name: "Hive in prod v0", at: "2026-10-29" },
  { key: "page", kind: "Page", name: "Hive: runs", at: "2026-10-28" },
  { key: "group", kind: "Group", name: "Hive crew", at: "2026-10-27" },
  { key: "routine", kind: "Routine", name: "Hive run digest", at: "2026-10-20" },
  { key: "thread", kind: "Thread", name: "Hive routines: per-run history", at: "2026-10-26" },
];
check(keys("hive", kinds).join() === "thread,routine,wip,page,group,task,worktree", "threads and routines, then pages, groups and WIP, then tasks, then worktrees");
check(KIND.Thread < KIND.Page && KIND.Page < KIND.Task && KIND.Task < KIND.Worktree, "the kinds, in that order");
// A kind not named goes with pages: a workspace, a note, a person, a screen.
const others = [
  { key: "worktree", kind: "Worktree", name: "Hive admin panel" },
  { key: "note", kind: "Note", name: "Hive notes" },
  { key: "thread", kind: "Thread", name: "Hive admin" },
];
check(keys("hive", others).join() === "thread,note,worktree", "a note goes with pages: after threads, before worktrees");
// Within a kind, how it's going still counts: working, then open.
const within = [
  { key: "idle", kind: "Thread", name: "Hive admin skills", at: "2026-10-30" },
  { key: "live", kind: "Thread", name: "Hive admin rebase", at: "2026-10-20", rank: RANK.going },
];
check(keys("hive", within).join() === "live,idle", "among threads, the one working first");
// What's put away or landed still goes last, whatever it is: an archived thread after an open worktree.
const away = [
  { key: "archived", kind: "Thread", name: "Hive admin, before", at: "2026-10-30", rank: RANK.away },
  { key: "merged", kind: "Worktree", name: "Hive admin: skills", at: "2026-10-30", rank: RANK.landed },
  { key: "open", kind: "Worktree", name: "Hive admin: routines", at: "2026-10-20" },
];
check(keys("hive", away).join() === "open,merged,archived", "an archived thread after an open and a merged worktree");
// What has every word in its name comes before what has one in what else it goes by: every thread in agentbook has
// "agentbook" in its line, and those mustn't bury the page named for it.
const flood = [
  ...Array.from({ length: 60 }, (_, i) => ({ key: `t${i}`, kind: "Thread", name: `Thread ${i}`, more: "sparrow · Claude · agentbook", at: `2026-10-${String((i % 30) + 1).padStart(2, "0")}` })),
  { key: "page", kind: "Page", name: "agentbook: soft launch", at: "2026-10-01" },
  { key: "named", kind: "Thread", name: "agentbook: ⌘K by kind", at: "2026-10-01" },
];
check(keys("agentbook", flood).slice(0, 2).join() === "named,page", "named for what's typed first: the thread, then the page, then threads only in agentbook");

const { terms } = rankPlaces(places, "reli <b>");
check(marked("Reliability <b>", terms, esc) === "<mark>Reli</mark>ability <mark>&lt;b&gt;</mark>", "what's typed is marked in the name, and the rest escaped");
check(marked("a < b", [], esc) === "a &lt; b", "with nothing typed, only escaped");

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall passed");
