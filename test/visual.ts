#!/usr/bin/env node
// More visual: what the page draws from what agentbook keeps (web/lib/visual.ts), a thread's
// life and its latest pictures on the feed (plugin/shared/life.ts, the store), the turn tools ab_compare and
// ab_diagram and ab_chart (plugin/shared/shapes.ts), the diagram widget and a chart's markers (widgets.ts), and a link's card
// (server/integrations/unfurl.ts). The pictures and link cards end to end are in test/pictures.ts.
// Run: node test/visual.ts

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isPicture, lifeOf } from "../plugin/shared/life.ts";
import { localPictures, shapeOf } from "../plugin/shared/shapes.ts";
import { createStore, publicState } from "../plugin/shared/store.ts";
import { ATTACHABLE, cleanData, widgetDocs } from "../plugin/shared/widgets.ts";
import { postForOthers } from "../server/policy.ts";
import { parseHead } from "../server/integrations/unfurl.ts";
import { blocksOf, cellNumber, checkDotsOf, diagramParts, layoutDiagram, lifeLayout, miniChartOf, miniTableBars, movedOf, pickedOf, planParts, stepKind, sortedRows, sortsAsNumber, tableBars, tableOrder, tableSort, thumbWidgets, tilesOf, timelineOf, widgetSpan } from "../web/lib/visual.ts";
import { describe } from "../plugin/shared/pages.ts";

let failures = 0;
const check = (cond: unknown, label: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const T = (min) => new Date(Date.parse("2026-11-01T10:00:00Z") + min * 60e3).toISOString();

// ---------- 4: a thread's life ----------
const thread = { id: "p1", started: T(0), updates: [{ at: T(20), text: "Shipped the card" }, { at: T(40), text: "Merged #4", pr: { kind: "merged" as const } }, { at: T(41), text: "Changed 3 files", changes: { files: 3 } }] };
const life = lifeOf(thread, {
  messages: [{ from: "agent", at: T(30) }, { from: "human", at: T(60), text: "Now the phone" }, { from: "agent", at: T(75) }, { from: "human", at: T(80), text: "queued", queued: true }],
  questions: [{ post: "p1", asked: T(31), answered: T(59) }, { post: "other", asked: T(5) }],
  files: [{ name: "a.png", at: T(29) }, { name: "b.png", at: T(29.3) }, { name: "notes.md", at: T(29) }, { name: "you.png", at: T(50), from: "human" }],
});
check(JSON.stringify(life.work) === JSON.stringify([[T(0), T(30)], [T(60), T(75)]]), "it worked from its start to its first reply, then from your message to its next");
check(life.wait.length === 1 && life.wait[0][1] === T(59), "it waited on you from its question to your answer (only its own questions)");
check(life.marks.map((m) => m.k).join() === "result,pic,merge,you" && life.marks[1].t === "2 pictures", "a mark for its result, the pictures it posted together (one mark), the merge and your message; not a change line, a file that isn't a picture, or one you sent");
check(lifeOf({ ...thread, busy: true, turn_started: T(90) }, { messages: [{ from: "agent", at: T(30) }] }).work.at(-1)[1] === null, "one working now has a stretch still going");
check(lifeOf({ id: "x", started: T(0), busy: true }, {}).work.join() === `${T(0)},` && lifeOf({ id: "x", started: T(0) }, {}) === null && lifeOf({ id: "x" }, {}) === null, "one working on its prompt has worked since it started; one stopped before it replied, or without a start, has nothing to draw");
const many = lifeOf({ id: "m", started: T(0) }, { messages: Array.from({ length: 200 }, (_, i) => ({ from: i % 2 ? "agent" : "human", at: T(i * 3) })) });
check(many.work.length <= 40, `a long thread's stretches are joined to 40 at most (${many.work.length})`);
check(isPicture({ name: "x.PNG" }) && isPicture({ name: "blob", type: "image/webp" }) && !isPicture({ name: "x.pdf" }), "a picture, by its name or its type");

// ---------- the feed: its latest pictures and its life ----------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-visual-"));
const store = createStore({ file: path.join(dir, "agentbook.db"), filesDir: path.join(dir, "files"), outbox: false, legacy: false });
const op = (o) => store.commit(o);
op({ t: "session.hello", proc: "a", agent: "claude", agent_name: "Claude", kind: "claude-code", session_id: "sa", label: "wren", cwd: dir, root: dir });
const post = "sa";
for (const n of ["one.png", "two.png", "notes.md", "three.jpg"]) op({ t: "file.add", post, from: "agent", name: n, size: 10, stored: n });
op({ t: "message.add", post, from: "agent", text: "Done" });
const card = publicState(store.state).sessions.find((s) => s.id === post);
check(card.pictures === 3 && card.last_pictures.map((f) => f.name).join() === "three.jpg,two.png,one.png", "a feed card has its latest pictures, newest first, and how many");
check(card.life?.work?.length === 1 && card.life.marks.some((m) => m.k === "pic"), "and its life");
const theirs = postForOthers({ ...card, show_work: false }, { visibility: "public" }, "herval");
check(theirs.last_pictures.length === 3 && theirs.pictures === 3 && theirs.life.marks.some((m) => m.k === "pic"), "someone else who sees it sees its pictures too: whoever sees a thread sees its work (an old show_work is ignored)");
store.close?.();

// ---------- 2 and 6: ab_compare ----------
const ba = shapeOf({ compare: { kind: "before_after", title: "The card", pictures: [{ picture: "/tmp/before.png", label: "Before" }, "https://x.test/after.png"] } });
check(ba.shape.compare.pictures.length === 2 && ba.shape.compare.title === "The card" && localPictures(ba.shape).join() === "/tmp/before.png", "before and after: two pictures, by path or https; the ones on its machine are sent up");
check(/takes 2 pictures/.test(shapeOf({ compare: { kind: "before_after", pictures: ["/tmp/a.png"] } }).error) && /https address/.test(shapeOf({ compare: { kind: "options", pictures: ["http://x.test/a.png", "/tmp/b.png"] } }).error) && /PNG, JPEG/.test(shapeOf({ compare: { kind: "sizes", pictures: ["/tmp/a.pdf", "/tmp/b.png"] } }).error), "too few pictures, plain http, or something that isn't a picture is turned away");
const opts = shapeOf({ compare: { kind: "options", pictures: [{ picture: "/tmp/a.png", label: "A. Cover" }, { picture: "/tmp/b.png", label: "B. Strip", pick: true, says: "Ship B" }, "/tmp/c.png", "/tmp/d.png", "/tmp/e.png"] } }).shape.compare;
check(opts.pictures.length === 4 && opts.pictures[1].pick && opts.pictures[1].says === "Ship B", "options: four at most, its pick marked, what picking it says");
check(/at most one/.test(shapeOf({ compare: { kind: "options", pictures: [{ picture: "/tmp/a.png", pick: true }, { picture: "/tmp/b.png", pick: true }] } }).error), "one pick at most");
check(shapeOf({ compare: { kind: "sizes", pictures: ["/tmp/desk.png", "/tmp/phone.png"] } }).shape.compare.pictures.map((p) => p.frame).join() === "desktop,phone", "sizes: the first a desktop's, the others phones', unless they say");
const nums = shapeOf({ compare: { kind: "numbers", numbers: [{ label: "p95", from: "412", to: 338, unit: "ms", better: "down" }] } }).shape.compare.numbers[0];
check(nums.from === 412 && nums.to === 338 && nums.better === "down" && /from and to/.test(shapeOf({ compare: { kind: "numbers", numbers: [{ label: "x", from: "a", to: 1 }] } }).error), "numbers: from and to as numbers, which way is better");
check(shapeOf({ cards: [{ title: "Mockup A", image: "/tmp/mk-a.png" }] }).shape.cards[0].image === "/tmp/mk-a.png", "a card's picture can be one on its machine now");
const moved = [{ label: "p95", from: 412, to: 338, unit: "ms", better: "down" as const }, { label: "Errors", from: 2, to: 5, better: "down" as const }, { label: "Same", from: 3, to: 3 }].map(movedOf);
check(moved[0].from === "412 ms" && moved[0].cls === "d good" && moved[0].change === "−18%" && moved[1].cls === "d bad" && moved[1].change === "+150%" && moved[2].change === "Same", "numbers that moved: the old one struck, the change colored by whether it's better");

// ---------- 8: diagrams ----------
const dg = shapeOf({ diagram: { title: "Why the export stalls", nodes: [{ id: "q", title: "Queue" }, "Worker", { title: "Ledger", state: "failed" }, { title: "Worker" }], edges: [{ from: "q", to: "Worker" }, { from: "Worker", to: "Ledger" }, { from: "Ledger", to: "q", label: "retry" }, { from: "q", to: "nowhere" }] } });
check(dg.shape.diagram.nodes.length === 4 && dg.shape.diagram.nodes[3].id === "Worker 2" && dg.shape.diagram.edges.length === 3, "a diagram: nodes by id or title (two alike made unique), edges between them");
check(dg.notes?.some((n) => /nowhere/.test(n)), "an edge to no node is left out, and it's told");
check(/needs nodes/.test(shapeOf({ diagram: { nodes: [] } }).error) && /state/.test(shapeOf({ diagram: { nodes: [{ title: "x", state: "great" }] } }).error), "no nodes, or a state it doesn't know, is turned away");
const L = layoutDiagram(dg.shape.diagram);
const col = (id) => L.nodes.find((n) => n.id === id).x;
check(col("q") < col("Worker") && col("Worker") < col("Ledger") && L.edges.find((e) => e.from === "Ledger").back, "laid out in columns along the arrows; the arrow closing the loop goes back underneath");
const chain = { nodes: ["Agent", "Server", "Store", "Page", "Frame"].map((t) => ({ id: t, title: t })), edges: [["Agent", "Server"], ["Server", "Store"], ["Store", "Page"], ["Page", "Frame"], ["Frame", "Agent"]].map(([from, to]) => ({ from, to })) };
const D = layoutDiagram(chain);
const box = (id) => D.nodes.find((n) => n.id === id);
check(D.down && box("Agent").y < box("Server").y && box("Page").y < box("Frame").y && D.width < 400 && D.edges.find((e) => e.from === "Frame").back, "a long chain goes top to bottom, narrow enough for a phone, the arrow back round the side");
const drawn = diagramParts(dg.shape.diagram);
check(drawn.boxes.length === 4 && drawn.boxes.some((b) => b.n.state === "failed" && b.title.startsWith("✕ ")) && drawn.labels.some((l) => l.text === "retry") && drawn.L.edges.length === 3 && drawn.min <= drawn.L.width && diagramParts({ nodes: [] }) === null, "drawn: its boxes, the failed one red, its arrows and their labels");
check(ATTACHABLE.includes("chart") && ATTACHABLE.includes("diagram") && widgetDocs(["diagram"]).includes("nodes"), "ab_attach takes a chart and a diagram, and the tool says how");
const out = { errors: [], notes: [] };
const chart = cleanData("chart", { x: ["Mon", "Tue"], series: [{ name: "p95", values: [400, 330] }], markers: [{ x: "Tue", label: "a41c9e deployed" }, "Mon"] }, out);
check(chart.markers.length === 2 && chart.markers[1].x === "Mon" && !out.errors.length, "a chart's markers: the moments that matter, at an x label");

// ---------- ab_chart: a chart on the reply ----------
const ch = shapeOf({ chart: { title: "p95 latency, last 5 days", x: ["2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"], series: [{ name: "checkout", values: [820, 790, "805", 330, 310] }, { values: [400, 410, 395, 380, 390, 999] }], unit: "ms", target: 300, markers: ["2026-10-31"], color: "red" } });
check(!ch.error && ch.shape.chart.title === "p95 latency, last 5 days" && ch.shape.chart.kind === "line" && ch.shape.chart.series[0].values[2] === 805 && ch.shape.chart.series[1].name === "Series 2" && ch.shape.chart.target.value === 300 && ch.shape.chart.markers[0].x === "2026-10-31", "a chart on the reply: a page's chart, checked as one (a line by default, numbers as numbers, an unnamed series numbered, a target and a marker by their short forms)");
check(ch.notes?.some((n) => /6 values for 5 x labels/.test(n)) && ch.notes?.some((n) => /chart\.color/.test(n)) && !("color" in ch.shape.chart), "and it's told what won't show: numbers past its labels, a field there's no such thing as");
check(/needs x/.test(shapeOf({ chart: { series: [{ name: "a", values: [1] }] } }).error) && /needs x/.test(shapeOf({ chart: { x: ["a"], series: [] } }).error) && /chart\.kind/.test(shapeOf({ chart: { kind: "pie", x: ["a"], series: [{ name: "a", values: [1] }] } }).error) && /a number/.test(shapeOf({ chart: { x: ["a"], series: [{ name: "a", values: ["lots"] }] } }).error), "no labels or no series, a kind it can't draw, or a value that isn't a number, is turned away saying why");
check(shapeOf({ chart: { kind: "bar", x: ["api", "web"], series: [{ name: "errors", values: [12, 3] }] } }).shape.chart.kind === "bar" && !shapeOf({ verdict: "done", line: "x", chart: { x: ["a"], series: [{ name: "a", values: [1] }] } }).error, "bars, and a chart beside the turn's other parts");

// ---------- stacked bars and scatter ----------
const st = shapeOf({ chart: { kind: "stacked", x: ["Sep", "Oct"], series: [{ name: "GCP", values: [3200, 2900] }, { name: "Datadog", values: [1400, 900] }] } });
check(!st.error && st.shape.chart.kind === "stacked" && st.shape.chart.series.length === 2, "stacked bars: x labels and values, as bars are");
const sc = shapeOf({ chart: { kind: "scatter", title: "p95 against traffic", series: [{ name: "Services", points: [[42, 180, "platform"], { x: 9, y: "610", label: "erp-sync" }, [128, 240]] }], unit: "ms", x_unit: "k req/day", markers: ["50"] } });
check(!sc.error && sc.shape.chart.series[0].points.length === 3 && sc.shape.chart.series[0].points[0].label === "platform" && sc.shape.chart.series[0].points[1].y === 610 && !("label" in sc.shape.chart.series[0].points[2]) && sc.shape.chart.x_unit === "k req/day" && !sc.notes?.length, "a scatter: points as [x, y, label?] or { x, y, label? }, no x labels needed, numbers as numbers");
check(/points is missing/.test(shapeOf({ chart: { kind: "scatter", series: [{ name: "a", values: [1, 2] }] } }).error) && /a scatter needs series/.test(shapeOf({ chart: { kind: "scatter" } }).error) && /points\[0\]\.y should be a number/.test(shapeOf({ chart: { kind: "scatter", series: [{ name: "a", points: [[1, "lots"]] }] } }).error), "a scatter without points, or a point that isn't two numbers, is turned away saying why");
check(/values is missing: one for each x \(points are a scatter's\)/.test(shapeOf({ chart: { x: ["a"], series: [{ name: "a", points: [[1, 2]] }] } }).error) && /chart needs x/.test(shapeOf({ chart: { kind: "stacked", series: [{ name: "a", values: [1] }] } }).error), "points on a line chart say they're a scatter's; stacked bars without x are turned away");
check(describe({ type: "chart", data: { kind: "scatter", series: [{ name: "a" }] } }) === "A scatter chart, 1 series" && describe({ type: "chart", data: { kind: "stacked", series: [{ name: "a" }, { name: "b" }] } }) === "A stacked bar chart, 2 series" && describe({ type: "chart", data: { series: [{ name: "a" }] } }) === "A chart, 1 series", "an agent reading a page hears what kind of chart it is");
const miniSc = miniChartOf({ kind: "scatter", series: [{ name: "a", points: [{ x: 1, y: 2 }, { x: 3, y: 5 }] }] });
const miniSt = miniChartOf({ kind: "stacked", x: ["a", "b"], series: [{ name: "a", values: [1, 2] }, { name: "b", values: [3, 1] }] });
check("dots" in miniSc && /h0M.*h0/.test(miniSc.dots) && "line" in miniSt && /^0\.0,[\d.]+ 100\.0,[\d.]+$/.test(miniSt.line), "page thumbnails: a scatter's dots, a stacked chart's totals");

// ---------- 1, 4, 5, 6: what the page draws ----------
const bar = planParts([{ text: "Read", status: "completed" }, { text: "Draw", now: "Drawing the strip", status: "in_progress" }, { text: "Ship", status: "pending" }]);
check(bar.done === 1 && bar.total === 3 && bar.now === "Drawing the strip" && bar.segs.join() === "d,n," && planParts([]) === null && planParts([{ text: "Ship", status: "pending" }]).next === "Ship", "a plan as a bar: how far, the step it's on, a segment each");
const strip = lifeLayout(life, { start: T(0), end: T(80) });
check(strip.work.length === 2 && strip.wait.length === 1 && strip.groups.length === 4 && strip.shown === 3 && strip.groups[3].marks.some((m) => m.t === "Now the phone"), "its life as a strip: its stretches, its wait, a mark each, the latest's words under it");
check(strip.waited === 28 * 60e3 && strip.worked === 45 * 60e3, "and how long it worked and waited");
const picked = lifeLayout(life, { start: T(0), end: T(80), pick: 0 });
check(picked.shown === 0 && picked.groups[0].marks.at(-1).t === "Shipped the card" && lifeLayout(life, { start: T(0), end: T(80), pick: 9 }).shown === 3, "a mark you pick shows its words (one that isn't there, the latest)");
const tiles = tilesOf({ files: 5, tiles: [{ path: "server/ui/app.js", add: 120, del: 40 }, { path: "test/visual.ts", add: 30, del: 0 }] });
check(tiles.tiles.length === 2 && !tiles.tiles[0].test && tiles.tiles[1].test && tiles.tiles[0].a === "75.00%" && tiles.tiles[0].name === "app.js" && tiles.more === 3 && Number(tiles.tiles[0].grow) > Number(tiles.tiles[1].grow), "a change as tiles: each as wide as it changed, green for added, a test outlined, the rest counted");
check(tilesOf({ files: 3, add: 2 }) === null, "a change from before tiles draws none");
check(checkDotsOf({ fail: 1, pass: 5, pending: 1, total: 7 }).join() === "x,p,,,,," && checkDotsOf({ pass: 90, fail: 10, total: 100 }).length <= 25 && !checkDotsOf({ total: 0 }).length, "checks as dots, a dot each, in proportion past 24");
const tb = tableBars([["api", "1,200"], ["web", "$600"], ["cron", "—"]], 2);
check(!tb.size && tableBars([["api", "1,200"], ["web", "$600"], ["cron", ""]], 2).get(1).join() === "100,50,", "bars in a table's column of numbers, against the largest; not in a column with words");
const srt = [["web", "$600", "412 ms", "2026-11-03", "v10"], ["api", "1,200", "95 ms", "2026-10-28", "v9"], ["cron", "", "1,300 ms", "", ""], ["Batch", "3.2k", "88.5 ms", "2026-11-01", "V2"]];
check(tableOrder(srt, 1, "desc").join() === "3,1,0,2" && tableOrder(srt, 1, "asc").join() === "0,1,3,2", "a table sorts by a column of numbers as numbers, either way, its empty cells last");
check(tableOrder(srt, 2, "asc").join() === "3,1,0,2" && tableOrder(srt, 3, "desc").join() === "0,3,1,2", "numbers with the same unit sort as numbers, days as days");
check(tableOrder(srt, 0, "asc").join() === "1,3,2,0" && tableOrder(srt, 4, "asc").join() === "3,1,0,2", "words sort A to Z whatever their case, the numbers in them counted");
check(tableOrder([["a", { status: "ok", text: "Fine" }], ["b", { meter: 40 }], ["c", "—"], ["d", { status: "bad", text: "Down" }]], 1, "asc").join() === "1,3,0,2" && tableOrder([["a", 1], ["b", 1], ["c", 0]], 1, "desc").join() === "0,1,2", "badges sort by their words, a dash counts as empty, equal rows keep the page's order");
check(sortsAsNumber(srt, 1) && !sortsAsNumber(srt, 0) && !sortsAsNumber(srt, 2), "a column of numbers is told from one of words");
const ownSort = { columns: ["Service", "Cost"], rows: [["web", "$600"], ["api", "1,200"], ["cron", ""]], sort: "-Cost" };
check(JSON.stringify(tableSort(ownSort)) === '{"col":1,"dir":"desc"}' && tableSort({ ...ownSort, sort: "Service" }).dir === "asc" && tableSort({ ...ownSort, sort: "-Nope" }) === null && tableSort({ ...ownSort, sort: undefined }) === null, "a table's own sort: its column and which way, none for a column it doesn't have");
check(sortedRows(ownSort).map((r) => r[0]).join() === "api,web,cron" && sortedRows({ ...ownSort, sort: "" })[0][0] === "web", "its rows in its own sort, or as written");
check(cellNumber("3.2k") === 3200 && cellNumber("−8%") === -8 && cellNumber({ status: "ok", text: "42" }) === 42 && cellNumber("n/a") === null, "numbers as they're written in cells");

// ---------- 10: where the time went ----------
check(stepKind({ tool: "Bash", title: "Run the smoke tests" }) === "test" && stepKind({ tool: "Bash", title: "Run node test/visual.ts" }) === "test" && stepKind({ tool: "Read" }) === "read" && stepKind({ tool: "Edit" }) === "edit" && stepKind({ tool: "mcp__claude-in-chrome__navigate" }) === "web" && stepKind({ tool: "Bash", title: "Run git status" }) === "run" && stepKind({ kind: "say" }) === "think", "a step is reading, editing, tests, the web, a command or thinking");
const steps = [
  { id: "1", at: T(0), done: T(1), tool: "Read", title: "Read app.js" },
  { id: "2", at: T(1.1), done: T(2), tool: "Read", title: "Read store.ts" },
  { id: "3", at: T(3), done: T(6), tool: "Edit", title: "Edit app.js" },
  { id: "4", at: T(7), done: T(12), tool: "Bash", title: "Run the tests" },
  { id: "5", at: T(200), done: T(201), tool: "Edit", title: "Edit visual.js" },
];
const blocks = blocksOf(steps, Date.parse(T(202)));
check(blocks[0].kind === "read" && blocks[0].steps.length === 2 && blocks.some((b) => b.kind === "test" && b.b - b.a === 5 * 60e3) && blocks.some((b) => b.kind === "think"), "its steps as stretches: two reads one stretch, the tests five minutes, the time between thinking");
const tl = timelineOf({ steps, workers: [{ id: "w", title: "Explore the feed", started: T(2), ended: T(8) }], you: [T(150)], waits: [[T(13), T(150)]], now: Date.parse(T(202)) });
check(tl.lanes.length === 2 && tl.lanes[1].name === "Explore the feed" && tl.folds.length >= 1 && tl.you.length === 1 && tl.you[0].l > 0, "a lane for it and one for its worker, a long quiet stretch folded, a mark where you wrote");
check(tl.legend.some((k) => k.name === "Tests" && k.pct > 0) && pickedOf(tl, "0:0")?.steps[0].title === "Read app.js" && pickedOf(tl, null) === null && pickedOf(tl, "5:0") === null, "the share of each kind, and the steps of the block you picked");
check(timelineOf({ steps: [] }) === null, "nothing to draw without steps");

// ---------- 7: a page as a thumbnail ----------
const thumb = thumbWidgets({ widgets: [{ id: "m", type: "metric", title: "p95", data: { value: 338, unit: "ms", series: [400, 380, 338] } }, { id: "t", type: "table", width: "half", data: { columns: ["svc", "errors"], rows: [["api", 4], ["web", 2]] } }, { id: "f", type: "filter", data: {} }] });
check(thumb.map((w) => w.id).join() === "m,t" && widgetSpan(thumb[0]) === 1 && widgetSpan(thumb[1]) === 2 && miniTableBars(thumb[1].data).join() === "100.00%,50.00%", "a page's thumbnail: its numbers, a table's bars, no filters");
check(thumbWidgets({ widgets: Array.from({ length: 12 }, (_, i) => ({ id: `w${i}`, type: "metric" as const })) }).length === 8, "two rows of four quarters at most");

// ---------- 9: a link's card ----------
const head = parseHead(`<html><head><title>Fallback</title><meta name="description" content="Plain &amp; simple"><meta property='og:image' content='/og.png'><meta property="og:site_name" content="Acme"></head><body><meta property="og:title" content="not in the head"></body>`, "https://www.acme.dev/releases/2.4");
check(head.title === "Fallback" && head.text === "Plain & simple" && head.site === "Acme" && head.image === "https://www.acme.dev/og.png", "a page's head: its title, description, site and picture, made absolute");
check(parseHead("<title>x</title>", "https://www.acme.dev/").site === "acme.dev" && parseHead("", "https://a.dev").title === null, "without a site name, its host; without a head, nothing");

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : "\nAll passed");
process.exit(failures ? 1 : 0);
