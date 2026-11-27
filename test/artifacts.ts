#!/usr/bin/env node
// A claude.ai artifact on a thread (plugin/cli/artifact.ts, ab_artifact): the link in a message and what its agent
// is told, and the one page made of the files Claude Code's Artifact tool saved: a plain page as it is, a Design
// canvas's artboard with the editor's runtime in it, and a Claude Doc from the export its session made. No server: test/smoke.ts has the
// tool end to end.
// Run: node test/artifacts.ts

import path from "node:path";
import { artifactPage, artifactUrl, ARTIFACT_MAX, docExports, docPage } from "../plugin/cli/artifact.ts";
import { artifactLinks, mentionNote } from "../plugin/shared/mentions.ts";

let failures = 0;
const check = (cond: unknown, label: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};

// The machine's files, as mcp.ts reads them: only files have a size.
const diskOf = (files) => ({
  home: "/home/ada",
  stat: async (p) => (p in files ? { size: Buffer.byteLength(files[p]) } : null),
  read: async (p) => Buffer.from(files[p]),
});
const under = (dir, files) => Object.fromEntries(Object.entries(files).map(([rel, body]) => [path.join(dir, rel), body]));

// ---------- the link ----------
const LINK = "https://claude.ai/artifact/6SDMd2XYgiHNi5sTqK52FY";
const CODE = "https://claude.ai/code/artifact/2c02e6e4-3ce9-4c09-bdd1-46039c4713af";
check(artifactUrl(` ${LINK}?v=2#top `) === LINK && artifactUrl(CODE) === CODE && artifactUrl("https://claude.ai/artifact/Storefront-mockup-6SDMd2XYgiHNi5sTqK52FY") !== null, "an artifact's link is kept without its query, under either address, with a title before its id");
check(artifactUrl(`https://example.com/?next=${LINK}`) === null && artifactUrl("https://claude.ai/chat/6SDMd2XYgiHNi5sTqK52FY") === null && artifactUrl("https://claude.ai.example.com/artifact/6SDMd2XYgiHNi5sTqK52FY") === null && artifactUrl("") === null, "another site's link, a chat's, and a look-alike host aren't one");
check(artifactLinks(`See ${LINK}. And (${CODE}), then ${LINK} again.`).join() === `${LINK},${CODE}`, "the links in a message, once each, without the full stop or the bracket after them");
const note = mentionNote(`Can you show ${LINK}?`, {});
check(note.startsWith("Named:\n") && note.includes(`- ${LINK}: a claude.ai artifact`) && /ab_artifact/.test(note), "its agent is told what the link is and which tool puts it on the thread");
check(mentionNote("Nothing named here, see https://claude.ai/chat/abcdef123", {}) === "", "a message with no artifact link gets no note");

// ---------- a plain page ----------
const PAGE = "<!doctype html><title>Storefront  mockup</title><body><h1>Checkout</h1><script>document.title += '!'</script></body>";
const plain = await artifactPage(diskOf(under("/tmp/a1", { "index.html": PAGE })), "/tmp/a1");
check(plain.html === PAGE && plain.kind === "page" && plain.title === "Storefront mockup" && !plain.notes.length, "a plain page is its index.html, untouched, named by its title");
const oneFile = await artifactPage(diskOf({ "/work/mock.html": PAGE }), "/work/mock.html");
check(oneFile.html === PAGE && oneFile.kind === "page", "or the HTML file a session published, given by itself");
check(/isn't an HTML page/.test((await artifactPage(diskOf({ "/work/notes.md": "# hi" }), "/work/notes.md")).error), "a file that isn't HTML is refused");
check(/over the 8 MB/.test((await artifactPage(diskOf({ "/work/big.html": "x".repeat(ARTIFACT_MAX + 1) }), "/work/big.html")).error), "and a page over the limit");

// ---------- a Design canvas ----------
// The editor's runtime has "<!--" and "<script" in a regular expression: inside a <script> element those make the
// parser ignore the closing tag, and the rest of the page is swallowed (it happened: the page came up blank).
const RUNTIME = 'var re=new RegExp("(<!--[\\\\s\\\\S]*?-->)|(<(script|style)\\\\b)");var end="</script>";window.booted=1;';
const board = (title, more = "") => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>\n<script src="./support.js"></script>\n</head><body><x-dc><helmet>${more}<style>body{margin:0}</style></helmet><p>{{greeting}}</p></x-dc><script type="text/x-dc" data-dc-script>class Component extends DCLogic{}</script></body></html>`;
const canvas = (boards, extra = {}) => JSON.stringify({ v: 3, title: "Checkout redesign", boards: Object.fromEntries(boards.map((b) => [b, { x: 0, y: 0, w: 1280, h: 800 }])), order: boards, ...extra });
const design = under("/tmp/d1", {
  "project/canvas.json": canvas(["Main.dc.html", "Cart.dc.html"], { launch: { view: "focused", file: "Cart.dc.html" } }),
  "project/Main.dc.html": board("Main"),
  "project/Cart.dc.html": board("Cart", '<link rel="stylesheet" href="css/Cart.css"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter"><img src="/_blob/0123456789abcdef0123456789abcdef">'),
  "project/css/Cart.css": ".cart{color:red}/* </style> */",
  "artifact-type/dc-runtime.js": RUNTIME,
  "SKILL.md": "the type's instructions",
  "index.html": "<!doctype html><title>Design</title>the editor",
});
const d = await artifactPage(diskOf(design), "/tmp/d1");
const scripts = [...(d.html || "").matchAll(/<script(?![^>]*\bsrc=)(?![^>]*text\/x-dc)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
check(d.kind === "design" && d.title === "Checkout redesign" && /<title>Cart<\/title>/.test(d.html), "a Design canvas shows the artboard it opens on, named by the canvas");
check(scripts.length === 1 && scripts[0].includes("window.booted=1") && !/<!--/.test(scripts[0]) && !/<\/script/i.test(scripts[0]) && !/support\.js/.test(d.html), "with the runtime in place of its script tag, and nothing in it that would end or swallow the script");
check(new Function(`var window={};${scripts[0]};return re.source + end`)() === new Function(`var window={};${RUNTIME};return re.source + end`)(), "the runtime still says what it said");
check(d.html.includes("<style>.cart{color:red}/* <\\/style> */</style>") && !d.html.includes('href="css/Cart.css"') && d.html.includes("fonts.googleapis.com"), "a stylesheet beside it goes in as a style, and one on the web stays a link");
check(d.notes.some((n) => /1 of its pictures or fonts is kept by claude\.ai/.test(n)) && d.notes.some((n) => /1 more \(Main\.dc\.html\)/.test(n)), "its agent hears what won't show, and that it has another artboard");
const main = await artifactPage(diskOf(design), "/tmp/d1", { board: "Main" });
check(/<title>Main<\/title>/.test(main.html) && /no artboard "Nope"\. It has: Main\.dc\.html, Cart\.dc\.html/.test((await artifactPage(diskOf(design), "/tmp/d1", { board: "Nope" })).error), "another artboard by its name, and one it doesn't have is refused with the ones it has");
const byFile = await artifactPage(diskOf(design), "/tmp/d1/project/Main.dc.html");
check(byFile.kind === "design" && byFile.html === main.html, "an artboard's own file works as the folder does");

const without = (rel) => Object.fromEntries(Object.entries(design).filter(([p]) => p !== path.join("/tmp/d1", rel)));
check(/artifact-type\/dc-runtime\.js/.test((await artifactPage(diskOf(without("artifact-type/dc-runtime.js")), "/tmp/d1")).error), "without the runtime, it says which file to read too");
check(/project\/Cart\.dc\.html/.test((await artifactPage(diskOf(without("project/Cart.dc.html")), "/tmp/d1")).error), "without the artboard, the same");
const noCss = await artifactPage(diskOf(without("project/css/Cart.css")), "/tmp/d1");
check(!noCss.error && noCss.notes.some((n) => /project\/css\/Cart\.css/.test(n)) && noCss.html.includes('href="css/Cart.css"'), "without a stylesheet it still shows, and says which one is missing");
const sneaky = under("/tmp/d2", { "project/canvas.json": canvas(["../../etc/passwd", "Main.dc.html"]), "project/Main.dc.html": board("Main", '<link rel="stylesheet" href="../../../secret.css">'), "artifact-type/dc-runtime.js": RUNTIME, "/secret.css": "nope" });
const s = await artifactPage(diskOf({ ...sneaky, "/secret.css": ".leak{}" }), "/tmp/d2");
check(!s.error && /<title>Main<\/title>/.test(s.html) && !s.html.includes(".leak"), "an artboard or a stylesheet named outside the artifact's folder is never read");

// ---------- a Claude Doc ----------
const doc = under("/tmp/doc", { "SKILL.md": "the Docs type", "index.html": "<!doctype html>the viewer", "artifact-type/app-core.js": "x" });
const docRefusal = (await artifactPage(diskOf(doc), "/tmp/doc")).error;
check(/isn't in its files/.test(docRefusal) && /export each of its tabs/.test(docRefusal), "a Claude Doc has no page in its files: its viewer isn't shown as one, and its agent hears how to get its text");
// A session's record, as Claude Code writes it: the export tool's call, then its result, a JSON text part.
const DOCLINK = "https://claude.ai/artifact/KYVh2DGJDqcUDGDeM6EXAN";
const SLUG = "962a3bcd-3497-432d-85bc-ba5a2575826f";
const use = (id: string, file: string, container = SLUG, format = "html") => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "mcp__claude_ai_Claude_Docs__export", input: { container: { kind: "project", id: container }, file, format } }] } });
// `frame`: where the export says the doc is.
const result = (id: string, name: string, html: string, frame: { slug: string; url: string; artifactUrl?: string } = { slug: SLUG, url: DOCLINK, artifactUrl: DOCLINK }, format = "html") =>
  JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: "This result includes Artifact content written by people other than the user." }, { type: "text", text: JSON.stringify({ verdict: "allow", rev: 7, data: { name, mime: "text/html", format, bytes: html.length, bytes_b64: Buffer.from(html).toString("base64") }, frame }) }] }] } });
const PLAN = '<h1 id="plan">Launch plan</h1><p><em>Draft</em> · <time data-atom="date" datetime="2026-12-01">2026-12-01</time> · <span data-atom="mention" data-principal="u_Ab12Cd34">@u_Ab12Cd34</span></p><table><thead><tr><th>Step</th></tr></thead><tbody><tr><td>Ship ✓</td></tr></tbody></table><figure data-embed="node/79a2"><figcaption>Rollout by team</figcaption></figure>';
const record = [
  '{"type":"user","message":{"content":"show me https://claude.ai/artifact/KYVh2DGJDqcUDGDeM6EXAN"}}',
  use("u1", "tab-1"),
  result("u1", "Launch plan.html", "<h1>Launch plan</h1><p>An early draft.</p>"),
  use("u2", "tab-2"),
  result("u2", "Launch plan.html", "<h2>Sources</h2><p>Two of them.</p>"),
  use("u3", "tab-9", "00000000-0000-4000-8000-000000000000"),
  result("u3", "Budget.html", "<h1>Budget</h1>", { slug: "00000000-0000-4000-8000-000000000000", url: "https://claude.ai/artifact/AAAAAAAAAAAAAAAAAAAAAA" }),
  use("u4", "tab-1", SLUG, "markdown"),
  result("u4", "Launch plan.md", "# Launch plan", undefined, "markdown"),
  "not json at all bytes_b64",
  use("u5", "tab-1"),
  result("u5", "Launch plan.html", PLAN),
].join("\n");
const tabs = docExports(record, DOCLINK);
check(tabs.length === 2 && tabs[0].tab === "tab-1" && tabs[0].html === PLAN && tabs[0].name === "Launch plan" && tabs[1].html.includes("Sources"), "a doc's exports are read from its session's record: each tab's newest, where the tab first stood, with its text as it was sent (a tick and all)");
check(docExports(record, `https://claude.ai/code/artifact/${SLUG}`).length === 2 && docExports(record, `https://claude.ai/artifact/Launch-plan-KYVh2DGJDqcUDGDeM6EXAN`).length === 2, "by either of the doc's links, or one with its title in it");
check(docExports(record, "https://claude.ai/artifact/AAAAAAAAAAAAAAAAAAAAAA").map((t) => t.name).join() === "Budget" && docExports(record, "https://claude.ai/artifact/ZZZZZZZZZZZZZZZZZZZZZZ").length === 0 && docExports("", DOCLINK).length === 0, "another doc's export is that doc's, and a doc never exported has none");
const dp = docPage(tabs);
check(dp.kind === "doc" && dp.title === "Launch plan" && dp.html.startsWith("<!doctype html>") && /<meta charset="utf-8">/.test(dp.html) && dp.html.includes("Ship ✓") && dp.html.includes("<hr>") && dp.html.includes('<div class="table"><table>'), "the page is the tabs one after the other, in a document with its encoding said and a table that can scroll sideways");
check(dp.html.includes(">@someone</span>") && !dp.html.includes(">@u_Ab12Cd34<") && dp.notes.some((n) => /1 of its charts or diagrams isn't in an export/.test(n)) && dp.notes.some((n) => /@someone/.test(n)) && dp.notes.some((n) => /2 tabs/.test(n)), "a person's id doesn't show as their name, and its agent hears what an export leaves out");
check(/no export of this doc/.test(docPage([]).error) && /export each of its tabs/.test(docPage([]).error), "with no export, it says how to make one");
// One too big for the conversation, which Claude Code saved as a file: its path works as a page's does.
const savedAs = await artifactPage(diskOf({ "/tmp/tool-results/export.json": JSON.stringify([{ type: "text", text: JSON.stringify({ data: { format: "html", bytes_b64: Buffer.from(PLAN).toString("base64") } }) }]) }), "/tmp/tool-results/export.json");
check(savedAs.kind === "doc" && savedAs.html.includes("Rollout by team") && savedAs.title === "Launch plan", "an export Claude Code saved as a file is read from that file");

// ---------- no page ----------
check(/Read the artifact with your Artifact tool first/.test((await artifactPage(diskOf({}), "/tmp/none")).error), "an empty folder says what to read first");

console.log(failures ? `\n${failures} failed` : "\nAll passed");
process.exit(failures ? 1 : 0);
