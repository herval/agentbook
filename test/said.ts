#!/usr/bin/env node
// What you say about something you point at, as a thread's message (web/lib/said.ts): a comment on lines of a diff,
// and marks on a picture. What goes to the agent has to read back as the same quote in the thread.
// Run: node test/said.ts

import { dvcText, dvcWhere, dvQuote, marksQuote, marksText, saidShort } from "../web/lib/said.ts";

let failures = 0;
const check = (cond: unknown, label: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};

// ---------- lines of a diff ----------
const added = [
  { c: "+", o: null, n: 5, text: 'const TYPES = new Set(["table", "embed"]);' },
  { c: "+", o: null, n: 6, text: "// Embeds run in a sandboxed frame." },
  { c: " ", o: 4, n: 7, text: "" },
];
const one = dvcText({ path: "plugin/server/server.mjs", lines: added }, "Should embed be in the list?\nAnd is allow-scripts enough?");
check(one.startsWith("On plugin/server/server.mjs, lines 5–7:\n```diff\n+const TYPES"), "it names the file and the lines, as the file has them now, over the lines as a diff");
const q = dvQuote(one);
check(q?.path === "plugin/server/server.mjs" && q.where === "lines 5–7" && !q.commit, "and reads back as its file and lines");
check(q?.lines.length === 3 && q.lines[0] === '+const TYPES = new Set(["table", "embed"]);' && q.lines[2] === " ", "with its lines, each with its sign, a blank one too");
check(q?.rest === "Should embed be in the list?\nAnd is allow-scripts enough?", "and what you wrote after them, all of it");
check(dvcWhere([{ c: "-", o: 88, n: null, text: "x" }]) === "removed line 88" && dvcWhere([{ c: "-", o: 88, n: null }, { c: "-", o: 90, n: null }]) === "removed lines 88–90", "removed lines say where they were");
check(dvcWhere([{ c: "-", o: 3, n: null }, { c: "+", o: null, n: 3 }]) === "line 3", "a change to a line names it as the file has it now");
check(dvcWhere([{ c: "+", o: null, n: null, text: "x" }]) === "", "lines without numbers name none");
const nonum = dvcText({ path: "notes.md", lines: [{ c: "+", o: null, n: null, text: "hi" }] }, "ok");
check(nonum.startsWith("On notes.md:\n") && dvQuote(nonum)?.path === "notes.md" && dvQuote(nonum).where === "", "and read back with none");
const commit = dvcText({ path: "a b/c.js", commit: "4f9a2c1d", lines: [{ c: "-", o: 12, n: null, text: "old()" }] }, "Why?");
const cq = dvQuote(commit);
check(commit.startsWith("On a b/c.js, removed line 12 (commit 4f9a2c1d):") && cq?.commit === "4f9a2c1d" && cq.where === "removed line 12" && cq.path === "a b/c.js", "one of its commits' says which commit, and reads back so");
const ticks = dvcText({ path: "README.md", lines: [{ c: "+", o: null, n: 1, text: "```js" }, { c: "+", o: null, n: 2, text: "x" }, { c: "+", o: null, n: 3, text: "```" }] }, "Fence?");
check(ticks.includes("\n````diff\n") && dvQuote(ticks)?.lines.length === 3 && dvQuote(ticks).rest === "Fence?", "code with a fence of its own gets a longer one, and reads back whole");
const long = dvcText({ path: "big.js", lines: Array.from({ length: 80 }, (_, i) => ({ c: "+", o: null, n: i + 1, text: `line ${i}` })) }, "Long");
check(dvQuote(long)?.lines.length === 60 && dvQuote(long).where === "lines 1–80", "at most 60 lines go, still naming them all");
check(dvQuote("On my way:\nsee you") === null && dvQuote("Just words") === null && dvQuote("") === null, "a message that only starts like one isn't one");
check(saidShort(one) === "plugin/server/server.mjs, lines 5–7: Should embed be in the list?\nAnd is allow-scripts enough?", "in a line: its file and lines, then what you wrote");

// ---------- marks on a picture ----------
const pins = [
  { x: 0.634, y: 0.527, text: "This bar should be the same blue" },
  { x: 0.26, y: 0.11, text: "Title is too heavy\nand too long" },
];
const marks = marksText("composer-phone.png", pins, { copy: "marked-composer-phone.png" });
check(marks.startsWith("Comments on the picture “composer-phone.png” (attached as marked-composer-phone.png, with my numbered marks on it)"), "marks name the picture and the copy with them on it");
check(marks.includes("\n1. (63% across, 53% down) This bar should be the same blue\n2. (26% across, 11% down) Title is too heavy\n   and too long"), "each by its number and where it is, a comment's next lines indented");
const mq = marksQuote(marks);
check(mq?.name === "composer-phone.png" && mq.items.length === 2 && mq.items[0].n === "1" && mq.items[1].text === "Title is too heavy\nand too long", "and read back as the picture and each comment, whole");
const away = marksText("Picture", [{ x: 0.5, y: 0.5, text: "Here" }], { url: "https://example.com/a.png" });
check(away.startsWith("Comments on the picture “Picture”, https://example.com/a.png,") && marksQuote(away)?.items[0].text === "Here", "one without a copy says where the picture is");
check(marksQuote("Comments on the picture “x”, each at…:\nbut then words") === null && marksQuote("Comments on the picture") === null, "something else isn't read as marks");
check(saidShort(marks) === "On “composer-phone.png”: 1. This bar should be the same blue 2. Title is too heavy\nand too long", "in a line: the picture, then each comment");
check(saidShort("just a message") === "just a message", "anything else stays as it is");

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
