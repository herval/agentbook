#!/usr/bin/env node
// What's typed in a terminal, until its shell has it: a page's side (web/lib/typing.ts) and the server's
// (server/terminals.ts). test/terminal.ts has it through real processes stopping.
// Run: node test/typing.ts

import { createTerminals, type TermSocket } from "../server/terminals.ts";
import { createTyping } from "../web/lib/typing.ts";
import type { Json } from "./harness-types.ts";

let failures = 0;
const check = (cond: unknown, label: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ---------- a page ----------
// What a page sends its terminal's socket as it's typed: `t: "in"`, under an id of the page's.
interface Typed {
  t: string;
  id: string;
  data: string;
}
// A page's side of what's typed (web/lib/typing.ts): `type` it, its socket `open` (and whether its terminal says
// what its shell `got`), `closed`, and whether it `says` what it got.
interface Typing {
  type(data: string): void;
  open(saysGot: boolean): void;
  got(id: string): void;
  closed(): void;
  says(acks: boolean): void;
}
// A page: what it sent, whether its socket is up, its typing, and the text of what it sent.
interface Page {
  sent: Typed[];
  open: boolean;
  typing: Typing;
  texts: () => string[];
}
const onPage = (): Page => {
  const p: Page = { sent: [], open: true, typing: createTyping((m: Typed) => p.open && (p.sent.push(m), true)), texts: () => p.sent.map((m) => m.data) };
  return p;
};
{
  const p = onPage();
  p.typing.open(true);
  p.typing.type("a");
  p.typing.type("b");
  check(same(p.texts(), ["a", "b"]) && p.sent.every((m) => m.t === "in" && /^[\w.-]{1,40}$/.test(m.id)) && p.sent[0].id !== p.sent[1].id, "a page sends what's typed as it's typed, each piece under an id of its own");
  const [a, b] = p.sent;
  p.typing.got(a.id);
  p.sent.length = 0;
  p.typing.closed();
  p.typing.open(true);
  check(same(p.sent, [b]), "its socket back, it sends what its shell didn't get, under the same id, and nothing else");
  p.sent.length = 0;
  p.typing.got(b.id);
  p.typing.closed();
  p.typing.open(true);
  check(!p.sent.length, "once its shell got it, it has nothing to send again");
}
{
  const p = onPage();
  p.typing.open(true);
  p.typing.type("on its way");
  p.typing.closed();
  p.open = false;
  p.typing.type("typed meanwhile");
  check(p.sent.length === 1, "with no socket, what's typed waits");
  p.open = true;
  p.sent.length = 0;
  p.typing.open(true);
  check(same(p.texts(), ["on its way", "typed meanwhile"]), "and goes after what's still on its way, in the order it was typed");
}
{
  const p = onPage();
  p.typing.open(false);
  p.typing.type("once");
  p.typing.closed();
  p.sent.length = 0;
  p.typing.open(false);
  check(!p.sent.length, "a terminal that can't say what it got hears each piece once: nothing goes again");
  p.typing.closed();
  p.open = false;
  p.typing.type("typed meanwhile");
  p.open = true;
  p.typing.open(false);
  p.typing.closed();
  p.typing.open(false);
  check(same(p.texts(), ["typed meanwhile"]), "and what's typed with no socket still waits for one, and goes once");
}
{
  const p = onPage();
  p.typing.open(false);
  p.typing.type("before");
  p.typing.says(true);
  p.typing.type("after");
  p.sent.length = 0;
  p.typing.closed();
  p.typing.open(true);
  check(same(p.texts(), ["after"]), "a terminal that comes to say what it got, once its machine is back, is kept from then on");
}
{
  const p = onPage();
  p.typing.open(true);
  p.typing.type("x".repeat(70000));
  p.typing.closed();
  p.sent.length = 0;
  p.typing.open(true);
  check(!p.sent.length, "a paste too big to keep still goes, once");
}

// ---------- the server ----------
// A WebSocket, a machine's line or a page's, that keeps what it was sent.
const socket = () => {
  const ws: TermSocket & { sent: Json[] } = { sent: [], send: (s) => ws.sent.push(JSON.parse(s)), close: () => ws.onClose?.() };
  return ws;
};
const inOf = (ws: { sent: Json[] }) => ws.sent.filter((m) => m.t === "in");
const tid = `t${"a".repeat(20)}`;
const set = () => {
  const terminals = createTerminals<object>({ whoIs: () => ({ id: "1" }), ownerOf: () => "1", postOf: (device, local) => local });
  const line = socket();
  terminals.machine("mac", line);
  return { terminals, line };
};
const hello = (line: TermSocket, acks?: boolean) => line.onMessage(JSON.stringify({ t: "hello", terms: [{ tid, post: "p1", cwd: "/x", shell: "zsh", ...(acks === undefined ? {} : { acks }) }] }));
{
  const { terminals, line } = set();
  hello(line, true);
  const T = terminals.of(tid);
  const page = socket();
  terminals.page(T, page, {}, null);
  check(page.sent[0].t === "hello" && page.sent[0].acks === true, "a page hears its terminal says what its shell got");
  page.onMessage(JSON.stringify({ t: "in", id: "p.1", data: "one" }));
  page.onMessage(JSON.stringify({ t: "in", id: "p.2", data: "two" }));
  page.onMessage(JSON.stringify({ t: "in", id: "p.3", data: "three" }));
  check(same(inOf(line).map((m) => m.id), ["p.1", "p.2", "p.3"]), "what's typed goes to its machine under the page's id");
  line.onMessage(JSON.stringify({ t: "got", tid, id: "p.1" }));
  check(page.sent.some((m) => m.t === "got" && m.id === "p.1"), "the page hears what its shell got");
  page.onMessage(JSON.stringify({ t: "in", id: "p.2", data: "two" }));
  check(inOf(line).length === 3, "a page sending again what the server still has doesn't send it twice");
  line.close();
  page.onMessage(JSON.stringify({ t: "in", id: "p.4", data: "four" }));
  const line2 = socket();
  terminals.machine("mac", line2);
  hello(line2, true);
  check(same(inOf(line2).map((m) => m.data), ["two", "three", "four"]), "its machine back, it hears what its shell didn't get, in order, typed while it was away last");
  check(same(inOf(line2).map((m) => m.id), ["p.2", "p.3", "p.4"]), "under the same ids");
  for (const id of ["p.2", "p.3", "p.4"]) line2.onMessage(JSON.stringify({ t: "got", tid, id }));
  line2.close();
  const line3 = socket();
  terminals.machine("mac", line3);
  hello(line3, true);
  check(!inOf(line3).length, "and what its shell got isn't kept");
}
{
  const { terminals, line } = set();
  hello(line, true);
  const page = socket();
  terminals.page(terminals.of(tid), page, {}, null);
  line.onMessage(JSON.stringify({ t: "got", tid: "t" + "b".repeat(20), id: "x" }));
  page.onMessage(JSON.stringify({ t: "in", id: "bad\nid", data: "named here" }));
  const m = inOf(line).at(-1);
  check(m.data === "named here" && /^[\w.-]{1,40}$/.test(m.id), "an id that won't do gets one that will: it never reaches the holder's frame");
  page.onMessage(JSON.stringify({ t: "in", data: "from an older page" }));
  check(/^[\w.-]{1,40}$/.test(inOf(line).at(-1).id), "a page from before this gets an id for what it types too, so it isn't lost as its machine stops");
}
{
  const { terminals, line } = set();
  hello(line);
  const T = terminals.of(tid);
  const page = socket();
  terminals.page(T, page, {}, null);
  check(page.sent[0].acks === false, "a machine that doesn't say what its shell got says so by saying nothing");
  page.onMessage(JSON.stringify({ t: "in", id: "p.1", data: "sent" }));
  line.close();
  page.onMessage(JSON.stringify({ t: "in", id: "p.2", data: "while away" }));
  const line2 = socket();
  terminals.machine("mac", line2);
  hello(line2);
  check(same(inOf(line2).map((m) => m.data), ["while away"]), "it hears what was typed while it was away, and not what it had, which would type it twice");
  line2.close();
  const line3 = socket();
  terminals.machine("mac", line3);
  hello(line3);
  check(!inOf(line3).length, "and only once");
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
