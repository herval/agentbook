#!/usr/bin/env node
// Who a box's @s address (namesIn, plugin/shared/mentions.ts), out of the names it lists: agents' and threads', with
// spaces, one the start of another. "@Claude Acme, take it from here" once went to the thread's own Claude.
// Run: node test/names-in.ts

import { namesIn } from "../plugin/shared/mentions.ts";

let failures = 0;
const check = (cond: unknown, label: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const same = (a: string[], b: string[]) => JSON.stringify(a) === JSON.stringify(b);

const names = ["Claude", "Claude Acme", "Claude (new)", "Codex", "petrel 2", "petrel 22", "Claude Desktop"];
check(same(namesIn("@Claude Acme let's take it from here. How's the data mapping going?", names), ["claude acme"]), "a name with a space is that agent, not the one its first word names");
check(same(namesIn("@Claude what do you think?", names), ["claude"]), "the shorter name still stands alone");
check(same(namesIn("@Claude (new) have a look", names), ["claude (new)"]), "the menu's new one of the thread's own agent brings one in");
check(same(namesIn("@petrel 22 and @petrel 2, compare notes", names), ["petrel 22", "petrel 2"]), "a thread's label, numbers and all, each @ once");
check(same(namesIn("ask @codex, then (@CLAUDE ACME) and @codex again", names), ["codex", "claude acme"]), "case doesn't count, a bracket can come before, and a name repeated is one");
check(same(namesIn("@Claude, @Claude's turn", names), ["claude"]), "punctuation after a name ends it");
check(same(namesIn("@Claudette and @Claude-code and @Codexes", names), []), "a longer word isn't a name it starts");
check(same(namesIn("mail ada@example.com or @someone", names), []), "an @ inside a word, or one naming nobody, addresses no one");
check(same(namesIn("", names), []) && same(namesIn(null, names), []) && same(namesIn("@Claude", []), []), "nothing to read, or no names, is nobody");

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
