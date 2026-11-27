#!/usr/bin/env node
// What a paste holds as text (web/lib/clip.ts), in the shapes iOS Safari hands a page: each `types` below is what it
// offered for that clipboard, on a real Paste in the simulator.
// Run: node test/clip.ts

import { clipText } from "../web/lib/clip.ts";

let failures = 0;
const check = (cond: unknown, label: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const clip = (types, files = []) => ({ getData: (t) => types[t] ?? "", files });

// A page's markup, as DOMParser would give it. Node has no DOMParser.
const text = (data) => ({ nodeType: 3, nodeName: "#text", data });
const el = (nodeName, ...kids) => ({ nodeType: 1, nodeName, childNodes: kids.map((k) => (typeof k === "string" ? text(k) : k)) });
const parsing = (body) => (globalThis.DOMParser = class { parseFromString = () => ({ body }); });

check(clipText(clip({ "text/plain": "hello" })) === "hello", "plain text, as it is");
check(clipText(clip({ "text/plain": "  two\nlines\n" })) === "  two\nlines\n", "plain text keeps its spaces and lines");
check(clipText(clip({ "text/plain": "plain", "text/html": "<b>rich</b>" })) === "plain", "plain text beside rich text wins");
check(clipText(clip({ "text/plain": "https://a.example/x", "text/uri-list": "https://b.example/y" })) === "https://a.example/x", "plain text beside a link wins");

// The share sheet's Copy: public.url and nothing else.
check(clipText(clip({ "text/uri-list": "https://www.notion.so/acme/The-feature-factory-abc123" })) === "https://www.notion.so/acme/The-feature-factory-abc123", "a link on its own");
check(clipText(clip({ "text/uri-list": "# a comment\r\nhttps://a.example/1\r\nhttps://b.example/2\r\n" })) === "https://a.example/1\nhttps://b.example/2", "a list of links, a line each, without its comments");

// public.rtf and nothing else.
parsing(el("BODY", el("P", el("SPAN", "rich  text\n only")), "\n", el("P", "second ", el("B", "line"))));
check(clipText(clip({ "text/html": "<p>…</p>" })) === "rich text only\nsecond line", "rich text alone: its words, a line to each block");
parsing(el("BODY", el("STYLE", "p { color: red }"), el("DIV", "one", el("BR"), "two"), el("UL", el("LI", "a"), el("LI", "b"))));
check(clipText(clip({ "text/html": "<div>…</div>" })) === "one\ntwo\na\nb", "rich text: a <br> is a line, a list an item to a line, a <style> no text");
parsing(el("BODY", el("IMG")));
check(clipText(clip({ "text/html": "<img>" })) === "", "rich text with no words in it has no text");

check(clipText(clip({ "text/plain": "text beside a picture" }, [{ name: "image.png" }])) === "text beside a picture", "text beside a file is still text");
check(clipText(clip({}, [{ name: "image.png" }])) === "", "a picture alone has no text");
check(clipText(clip({ "text/plain": "photo.png" }, [{ name: "photo.png" }])) === "", "a file copied in Finder: its name isn't text to paste");
check(clipText(clip({ "text/plain": "a.png\nb.pdf\n" }, [{ name: "a.png" }, { name: "b.pdf" }])) === "", "nor are the names of several");
check(clipText(clip({ "text/plain": "a.png is broken" }, [{ name: "a.png" }])) === "a.png is broken", "words that mention a file are text");

check(clipText(clip({})) === "", "nothing on it (a type the page isn't shown): no text");
check(clipText(null) === "", "no clipboard at all");

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
