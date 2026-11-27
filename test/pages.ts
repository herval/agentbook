#!/usr/bin/env node
// Pages: an agent makes one and keeps it up to date, every change is a version, an older one can be restored,
// only contributors change it, and only its owner says who they are and who sees it. Pages and their versions
// survive a restart. Run: node test/pages.ts

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contextText } from "../plugin/cli/context.ts";
import { expandMentions, mentionNote, mentionsIn } from "../plugin/shared/mentions.ts";
import { handle } from "../plugin/cli/mcp.ts";
import { changesBetween, widgetFrom } from "../plugin/shared/pages.ts";
import { ATTACHABLE, WIDGETS, widgetDocs } from "../plugin/shared/widgets.ts";
import { DatabaseSync } from "./harness-sql.ts";
import { type Agentbook, spawnAgentbook, testPort } from "./harness.ts";
import { stateOf } from "./harness-state.ts";
import type { Json } from "./harness-types.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "plugin");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-pages-"));
// The machine shares the test's folders with its server, and starts as many posts as the test does (its gate).
fs.mkdirSync(path.join(HOME, "cli"), { recursive: true });
fs.writeFileSync(path.join(HOME, "cli", "gate.json"), JSON.stringify({ folders: [HOME], starts_per_hour: 1000 }));
const PORT = testPort(4700);
const URL = `http://127.0.0.1:${PORT}`;
const FAKE = path.join(HOME, "fake-claude");
fs.mkdirSync(FAKE);
const env = { ...process.env, AGENTBOOK_HOME: HOME, AGENTBOOK_PORT: String(PORT), AGENTBOOK_CODEX: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_TERMINAL: "0", AGENTBOOK_CLAUDE: path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-claude.ts"), FAKE_CLAUDE_DIR: FAKE, CLAUDE_CONFIG_DIR: path.join(HOME, "claude"), AGENTBOOK_CLONE_DIR: path.join(HOME, "clones"), AGENTBOOK_CHECKPOINT_MS: "200" };
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_URL", "AGENTBOOK_OWNER"]) delete env[k];
const project = path.join(HOME, "dev", "app");
fs.mkdirSync(project, { recursive: true });

let failures = 0;
const check = (cond: unknown, label: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function req(method: string, p: string, { body, cookie }: { body?: unknown; cookie?: string } = {}): Promise<Json> {
  const r = await fetch(URL + p, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let data: Json = {};
  try {
    data = JSON.parse(text);
  } catch {
    data = { text };
  }
  return { status: r.status, cookie: (r.headers.get("set-cookie") || "").split(";")[0], ...data };
}
const as = (cookie: string) => ({ cookie, get: (p: string) => req("GET", p, { cookie }), post: (p: string, body?: unknown) => req("POST", p, { cookie, body: body || {} }) });
const agent = (proc: string) => ({ get: (p: string) => req("GET", `/api/procs/${proc}${p}`), post: (p: string, body?: unknown) => req("POST", `/api/procs/${proc}${p}`, { body }) });

let server: Agentbook;
async function start() {
  server = spawnAgentbook({ env, stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(URL + "/api/health")).ok) return;
    } catch {}
    await sleep(100);
  }
}
async function stop() {
  const gone = new Promise((r) => server.once("exit", r));
  server.kill("SIGTERM");
  await gone;
}

// ---------- the parts that need no server ----------
{
  const a = widgetFrom({ id: "p95", type: "metric", title: "p95 latency", data: { value: 412, unit: "ms" } });
  const b = widgetFrom({ id: "p95", data: { value: 388 } }, a);
  check(b.type === "metric" && b.data.unit === "ms" && b.data.value === 388 && b.width === "quarter", "a widget's data merges over the one it updates, and its width defaults by type");
  const t = widgetFrom({ id: "slo", type: "table", data: { columns: ["Service", "SLO"], rows: [{ Service: "api", SLO: "99.9%" }, ["web", "99.5%"]] } });
  check(JSON.stringify(t.data.rows) === JSON.stringify([["api", "99.9%"], ["web", "99.5%"]]), "table rows given as objects become rows in column order");
  const ts = widgetFrom({ id: "slo", type: "table", data: { columns: ["Service", "SLO"], rows: [["api", "99.9%"]], sort: "-SLO" } });
  let noCol = null;
  try {
    widgetFrom({ id: "slo", type: "table", data: { columns: ["Service", "SLO"], rows: [["api", "99.9%"]], sort: "-Cost" } });
  } catch (e) {
    noCol = e;
  }
  check(ts.data.sort === "-SLO" && /sort: no column "Cost" \(Service, SLO\)/.test(noCol?.message || ""), "a table keeps the column its agent sorts it by, and one it doesn't have is refused by name");
  let threw = null;
  try {
    widgetFrom({ id: "x", type: "gauge" });
  } catch (e) {
    threw = e.message;
  }
  check(/type must be one of/.test(threw || ""), "an unknown widget type is refused, saying which ones there are");
  const ch = changesBetween({ title: "A", widgets: [a, t] }, { title: "A", widgets: [b] });
  check(ch.some((c) => c.id === "p95" && c.from === "412 ms" && c.to === "388 ms") && ch.some((c) => c.id === "slo" && c.kind === "removed"), "changes say how a number moved and which widgets went");
  const now = Date.parse("2026-10-10T12:00:00Z");
  const page = { id: "reliability", title: "Reliability", about: "Prod health for the API", version: 3, url: "http://x/#/pages/reliability", canEdit: true, last: { at: "2026-10-09T15:00:00Z", by: "heron (Claude), in \"Build it\"", summary: "Refreshed latency" }, widgets: [{ id: "p95", title: "p95 latency", what: "a number, 412 ms" }, { id: "slo", title: "SLOs", what: "a table, 5 rows" }], others: [{ label: "kite", agent: "Claude", title: "Keep it fresh", working: true }] };
  const told = contextText({ kind: "claude-code", agent: "Claude", label: "wren", person: "herval", now, page, pages: [{ id: "reliability", title: "Reliability", version: 3 }, { id: "costs", title: "Costs", version: 1 }] });
  check(/herval started this thread from the page "Reliability" \(reliability, http:\/\/x\/#\/pages\/reliability\), so "this" or "it" means the page/.test(told), "an agent is told the page its post was written from, and that it's what \"this\" means");
  check(/v3, last changed 21 hours ago by heron \(Claude\), in "Build it": "Refreshed latency"/.test(told) && /keeps track of: "Prod health for the API"/.test(told) && /p95 \("p95 latency", a number, 412 ms\); slo \("SLOs", a table, 5 rows\)/.test(told), "and what's on it: its widgets, its last change, what it keeps track of");
  check(/Also open on it: kite \(Claude\), "Keep it fresh", working now/.test(told), "and the other posts on it");
  check(/ab_page_write with page: "reliability" adds, changes, removes and reorders widgets/.test(told) && /herval can see and restore/.test(told), "and what it can do with it");
  check(/Keep it one page: put what you have in the widgets that are there before you add one/.test(told) && !/more than reads well/.test(told), "and to keep it one page");
  const big = contextText({ kind: "claude-code", agent: "Claude", person: "herval", now, page: { ...page, widgets: Array.from({ length: 24 }, (_, i) => ({ id: `w${i}`, title: `W${i}`, what: "a note" })) } });
  check(/It has 24 widgets, more than reads well \(about 12\): fold some together when you change it/.test(big), "and when it has more widgets than reads well, how many");
  check(/Other pages you keep: "Costs" \(costs, v1\)\./.test(told), "the pages it keeps don't name that one again");
  check(/You can read it with ab_page_read, but not change it/.test(contextText({ kind: "claude-code", agent: "Claude", person: "herval", now, page: { ...page, canEdit: false } })), "an agent that doesn't contribute to it is told it can only read it");
  check(/Pages you keep: "Reliability" \(reliability, v3\)/.test(contextText({ kind: "claude-code", agent: "Claude", person: "herval", pages: [{ id: "reliability", title: "Reliability", version: 3 }] })), "an agent is told the pages it keeps");
  check(!/ab_page_write/.test(contextText({ kind: "openclaw", agent: "reel", pages: null })), "an agent that can't write pages isn't told about them");

  // ---------- naming a page, or one of its widgets, in a message ----------
  const byId = {
    reliability: { id: "reliability", title: "Reliability", version: 3, updated: "2026-10-10T11:00:00Z", widgets: [{ id: "p95", type: "metric" as const, title: "p95 latency", data: { value: 412, unit: "ms" }, v: 3, at: "2026-10-10T11:40:00Z" }, { id: "costs", type: "note" as const, title: "Cost note", data: {} }] },
    costs: { id: "costs", title: "Costs", version: 1, updated: "2026-10-09T12:00:00Z", widgets: [] },
  };
  const said = expandMentions("why did @p95 move? and @costs, (@p95). @nope, a@b.com, @anthropic-ai/sdk, @reliability/p95", byId.reliability);
  check(said === "why did @reliability/p95 move? and @reliability/costs, (@reliability/p95). @nope, a@b.com, @anthropic-ai/sdk, @reliability/p95", "a widget named in short is written out in full, against the page the message is about; a widget there wins over a page with its id, and the rest stays as it is");
  check(mentionsIn("@costs and @reliability/p95, @reliability/p95 again, @reliability/gone, @nope, @reliability/", byId).map((m) => m.ref).join(" ") === "costs reliability/p95", "a message names each page and widget once, and nothing that isn't there");
  check(mentionNote("compare @reliability/p95 with @costs", byId, now) === 'Named:\n- @reliability/p95: the widget "p95 latency" on the page "Reliability": a number, 412 ms (changed in v3, 20 minutes ago)\n- @costs: the page "Costs", 0 widgets (v1, changed 24 hours ago)', "the agent's note says what each one is, and what a widget showed then");
  check(mentionNote("@nope, and nothing else", byId, now) === "", "a message that names nothing has no note");
  const spaces = { wab1: { id: "wab1", name: "agentbook", repo: "herval/agentbook", checkouts: [{ machine: "m5", root: "/Users/h/dev/agentbook" }, { machine: "brick", root: "/home/h/agentbook" }] }, wcd2: { id: "wcd2", name: "iac", repo: null, checkouts: [{ machine: "m5", root: "/Users/h/iac" }] } };
  check(mentionNote("in @ws:wcd2, is @costs right? see @ws:wab1, @ws:wab1 and @ws:nope", byId, now, spaces) === 'Named:\n- @ws:wcd2: the workspace "iac", the folder /Users/h/iac on m5\n- @costs: the page "Costs", 0 widgets (v1, changed 24 hours ago)\n- @ws:wab1: the workspace "agentbook", the repo herval/agentbook, checked out at /Users/h/dev/agentbook on m5, and at /home/h/agentbook on brick', "a workspace named in a message is in the note, where it is, in the order they're named, once each");
  check(mentionsIn("@ws:wab1 and @ws", { ws: { id: "ws", title: "WS", widgets: [] } }).map((m) => m.ref).join(" ") === "ws" && expandMentions("@ws:wab1", { id: "p", widgets: [{ id: "ws", type: "note" }] }) === "@ws:wab1", "a workspace's token is never a page's, or a widget's in short");
  check(/herval may name a page as @page, or one of its widgets as @page\/widget/.test(told) && !/may name a page/.test(contextText({ kind: "openclaw", agent: "reel", pages: null })), "an agent that reads pages is told how they're named; one that can't isn't");

  // A widget of its own keeps the data it's given as it is: agentbook doesn't know its shape.
  const rate = (d: unknown) => (d && typeof d === "object" && "rate" in d ? d.rate : undefined);
  const h = widgetFrom({ id: "calc", type: "html", title: "Calculator", data: { html: "<p>hi</p>", js: "x()", data: { rate: 3 }, height: 9000, extra: "dropped" } });
  check(h.width === "half" && h.data.html === "<p>hi</p>" && h.data.js === "x()" && h.data.css === "" && rate(h.data.data) === 3 && h.data.height === 1600 && !("extra" in h.data), "a widget of its own keeps its html, css, js, data and a height it can start at (up to 1600), and nothing else");
  const h2 = widgetFrom({ id: "calc", data: { data: { rate: 4 } } }, h);
  check(h2.data.html === "<p>hi</p>" && rate(h2.data.data) === 4, "its data changes without sending its code again (a routine's refresh)");
  const hc = (a, b) => changesBetween({ title: "A", widgets: [a] }, { title: "A", widgets: [b] })[0]?.text;
  check(hc(h, h2) === "New data" && hc(h, widgetFrom({ id: "calc", data: { css: "p{}" } }, h)) === "Rebuilt", "a version says whether it got new data or was rebuilt");

  // A table's version says which rows changed and how, finding each row by its first cell.
  const tc = (rows, next, columns = ["Where", "Status", "How"], cols = columns) => changesBetween({ title: "A", widgets: [widgetFrom({ id: "t", type: "table", data: { columns, rows } })] }, { title: "A", widgets: [widgetFrom({ id: "t", type: "table", data: { columns: cols, rows: next } })] })[0];
  const dirs = [["DevHunt", { status: "bad", text: "Not submitted" }, "launch"], ["Uneed", { status: "ok", text: "Listed" }, "form"], ["Fazier", { status: "bad", text: "Not submitted" }, "form"]];
  const one = tc(dirs, dirs.map((r, i) => (i === 0 ? [r[0], { status: "ok", text: "Listed" }, "free queue"] : r)));
  check(one.text === "DevHunt: Not submitted → Listed" && JSON.stringify(one.rows) === '[{"kind":"changed","key":"DevHunt","col":"Status","from":"Not submitted","to":"Listed","was":"bad","status":"ok"}]', "a row that changed says what it said and says now, in the column whose status moved");
  const shifted = tc(dirs, [["Product Hunt", { status: "bad", text: "Not submitted" }, "launch"], ...dirs.slice(0, 2)]);
  check(shifted.text === "Added Product Hunt; removed Fazier" && shifted.rows.map((r) => `${r.kind} ${r.key}`).join(", ") === "added Product Hunt, removed Fazier", "a row added at the top is one row added, not every row below it changed");
  const pages = Array.from({ length: 20 }, (_, i) => [`/p${i}`, { status: "ok", text: `200 · ${1500 + i} ms` }, "x"]);
  const slow = tc(pages, pages.map((r, i) => (i === 7 ? [r[0], { status: "bad", text: "404" }, "x"] : [r[0], { status: "ok", text: `200 · ${1600 + i} ms` }, "x"])));
  check(slow.text === "Status changed in 20 rows" && slow.rows.length === 6 && slow.more === 14 && slow.rows[0].key === "/p7" && slow.rows[0].to === "404", "many changed rows say which column moved, and keep a few, the one whose status moved first");
  check(tc(dirs, dirs.map((r) => [r[0], r[2], r[1]]), ["Where", "Status", "How"], ["Where", "How", "Status"]).text === "Columns reordered" && tc(dirs, [...dirs].reverse()).text === "Rows reordered", "columns or rows put in another order aren't every cell changed");
  check(tc([["4", "Hermes GUI", "weak"]], [["4", "Hermes GUI", "fixed"]], ["#", "Question", "Why"]).rows[0].key === "4 · Hermes GUI", "a row whose first cell is a number is named by its second too");
  const fw = widgetFrom({ id: "service", type: "filter", title: "Service", data: { values: ["api", "web", "api", " "], all: "All services", extra: 1 } });
  check(fw.width === "full" && fw.data.values.join() === "api,web" && fw.data.all === "All services" && !("extra" in fw.data), "a filter keeps its values (once each) and what all of them are called");
  const ft = widgetFrom({ id: "slo", type: "table", data: { columns: ["Service", "SLO"], rows: [["api", "99.9%"]], match: { service: "Service", "no good": "x", n: 3 }, per: { service: { api: { rows: [{ Service: "api", SLO: "99.95%" }] }, web: "not an object" } } } });
  check(JSON.stringify(ft.data.match) === '{"service":"Service"}' && JSON.stringify(ft.data.per) === '{"service":{"api":{"rows":[["api","99.95%"]]}}}', "a widget follows a filter by where its value is (match), or by what it shows for each value (per), checked like its own data");
  const fm = widgetFrom({ id: "p95", type: "metric", data: { value: 412, per: { service: { api: { value: 380 } } } } });
  check(widgetFrom({ id: "p95", data: { value: 400 } }, fm).data.per.service.api.value === 380, "a refresh of its number keeps what it shows per value");
  const tf = widgetFrom({ id: "when", type: "filter", data: { kind: "time", values: ["7d", "30d", "last week", "7d", "2w", "0d"] } });
  check(tf.data.kind === "time" && tf.data.values.join() === "7d,30d,2w", "a time filter keeps the periods it understands (hours, days, weeks), once each");
  check(widgetFrom({ id: "when", type: "filter", data: { kind: "time" } }).data.values.join() === "24h,7d,30d,90d", "and without any, it offers the last 24 hours, 7, 30 and 90 days");

  // ---------- one definition of each kind (widgets.ts) ----------
  const listed = await handle({ id: 1, method: "tools/list" }, { proc: "x" });
  const tools = Object.fromEntries(("result" in listed ? listed.result : null).tools.map((t) => [t.name, t]));
  check(tools.ab_page_write.description.includes(widgetDocs()) && tools.ab_attach.description.includes(widgetDocs(ATTACHABLE)) && tools.ab_attach.inputSchema.properties.type.enum.join() === ATTACHABLE.join(), "ab_page_write and ab_attach describe widgets from their definitions");
  const docs = widgetDocs();
  check(/- metric: data \{ value, unit\?, .*status\? \(a badge under it/.test(docs) && /image\? \(a picture of it\)/.test(docs) && /label\? \(beside its status\)/.test(docs) && !/\bok_by\b|\bchosen\?/.test(docs), "so agents hear of every field the page draws (a metric's status, an option's image, a list item's label), and not of what the page sets itself");
  check(Object.keys(WIDGETS).every((t) => docs.includes(`- ${t}: data {`)), "every kind is described");
  let wrong = null;
  try {
    widgetFrom({ id: "p95", type: "metric", width: "wide", data: { value: { n: 412 }, good: "higher" } });
  } catch (e) {
    wrong = e.message;
  }
  check(/width should be one of quarter/.test(wrong) && /data\.value should be text, not \{"n":412\}/.test(wrong) && /data\.good should be 'up' or 'down', not "higher"/.test(wrong), "a widget written wrong is refused with all that's wrong in it, field by field");
  const missing = (() => {
    try {
      widgetFrom({ id: "c", type: "chart", data: { kind: "area", series: [{ name: "p95", values: [1, "slow"] }] } });
    } catch (e) {
      return e.message;
    }
  })();
  check(/data\.kind should be 'line', 'bar', 'stacked' or 'scatter'/.test(missing) && /data\.x is missing/.test(missing) && /data\.series\[0\]\.values\[1\] should be a number, not "slow"/.test(missing), "what it needs and doesn't have is missing, and a value that isn't a number is named where it is");
  const notes = [];
  const cut = widgetFrom({ id: "slo", type: "table", data: { columns: ["Service"], rows: Array.from({ length: 520 }, (_, i) => [`s${i}`]), sorted: true } }, null, notes);
  check(cut.data.rows.length === 500 && !("sorted" in cut.data) && notes.some((n) => /kept the first 500 of the 520 in data\.rows/.test(n)) && notes.some((n) => /left out data\.sorted: there's no such field/.test(n)), "what's past its limits is cut, and a field it doesn't have left out, each with a note for whoever wrote it");
  const itemNotes = [];
  widgetFrom({ id: "pick", type: "options", data: { items: [{ name: "A", score: 1 }, { name: "B", score: 2 }] } }, null, itemNotes);
  check(itemNotes.length === 1 && /data\.items\[…\]\.score/.test(itemNotes[0]), "the same note about each item of a list comes once");
  const ordered = widgetFrom({ id: "p95", type: "metric", data: { unit: "ms", value: 412, good: "down" } });
  check(Object.keys(ordered.data).join() === "unit,value,good" && widgetFrom({ id: "l", type: "list", data: { items: [{ text: "api", day: "2026-10-03" }] } }).data.items[0].day === "2026-10-03", "it keeps fields in the order given (so a refresh of the same changes nothing), and a list item's own fields a filter can match on");
}

try {
  await start();
  const owner = as((await req("POST", "/api/auth/test-person", { body: { username: "herval" } })).cookie);
  const alice = as((await req("POST", "/api/auth/test-person", { body: { username: "alice" } })).cookie);
  const nobody = as(null);
  await req("POST", "/api/hello", { body: { proc: "box-1", label: "osprey", agent: "Claude", session_id: "sess-a", cwd: project } });
  await req("POST", "/api/hello", { body: { proc: "box-2", label: "lark", agent: "Codex", kind: "codex", session_id: "sess-b", cwd: project } });
  const claude = agent("box-1");
  const codex = agent("box-2");

  // ---------- an agent makes a page ----------
  const made = await claude.post("/pages", {
    title: "Reliability: platform",
    emoji: "📈",
    widgets: [
      { id: "p95", type: "metric", title: "p95 latency", data: { value: 412, unit: "ms", good: "down" } },
      { id: "slo", type: "table", title: "SLOs", data: { columns: ["Service", "Budget"], rows: [["api", { meter: 78 }]] } },
    ],
  });
  check(made.status === 200 && made.created && made.id === "reliability-platform" && made.version === 1 && /#\/pages\/reliability-platform$/.test(made.url), "an agent makes a page: its id comes from its title, and it's v1");
  const id = made.id;
  let page = (await stateOf(owner.get)).pages.find((p) => p.id === id);
  check(page && page.visibility === "private" && page.mine && page.can_edit && page.widgets.length === 2 && page.contributors.some((c) => c.agent === "claude" && c.role === "made"), "its owner sees it, private, with the agent that made it as a contributor");
  check(!(await stateOf(alice.get)).pages.some((p) => p.id === id) && (await alice.get(`/api/pages/${id}`)).status === 404, "someone else doesn't see a private page");
  check((await nobody.get(`/api/pages/${id}`)).status === 401, "signed out sees nothing");
  const again = await claude.post("/pages", { title: "Reliability: platform" });
  check(again.id === "reliability-platform-2", "a second page with the same title gets an id of its own");
  await owner.post(`/api/pages/${again.id}/archive`, { archived: true });

  // ---------- it keeps it up to date ----------
  const v2 = await claude.post("/pages", { page: id, widgets: [{ id: "p95", data: { value: 388 } }], summary: "Refreshed latency" });
  check(v2.status === 200 && v2.changed && v2.version === 2, "an update makes v2");
  const same = await claude.post("/pages", { page: id, widgets: [{ id: "p95", data: { value: 388 } }] });
  check(same.status === 200 && !same.changed && same.version === 2, "a write that changes nothing makes no version");
  page = (await stateOf(owner.get)).pages.find((p) => p.id === id);
  check(page.last.summary === "Refreshed latency" && page.last.changes[0].from === "412 ms" && page.last.changes[0].to === "388 ms" && page.widgets[0].v === 2 && page.widgets[1].v === 1, "the latest version says what changed, and each widget which version last changed it");
  const read = await claude.get(`/pages/${id}`);
  check(read.widgets?.length === 2 && read.widgets[0].data.value === 388 && read.can_edit, "ab_page_read gives the widgets as data");
  const listed = await claude.get("/pages");
  check(listed.pages.length === 1 && listed.pages[0].id === id, "ab_page_list leaves archived pages out");
  const bad = await claude.post("/pages", { page: id, widgets: [{ id: "g", type: "gauge" }] });
  check(bad.status === 400 && /type must be one of/.test(bad.error), "a bad widget is refused with what's wrong");
  const bad2 = await claude.post("/pages", { page: id, widgets: [{ id: "p95", data: { good: "higher" } }, { id: "lat", type: "chart", data: { kind: "area", x: ["Mon"], series: [{ name: "p95", values: [412] }] } }] });
  check(bad2.status === 400 && /Nothing was saved/.test(bad2.error) && /Widget "p95": data\.good should be/.test(bad2.error) && /Widget "lat": data\.kind should be/.test(bad2.error) && (await claude.get(`/pages/${id}`)).version === 2, "a write with widgets written wrong saves none of them, and says what's wrong in each");
  const noted = await claude.post("/pages", { page: id, widgets: [{ id: "p95", data: { value: 388, trend: "flat" } }] });
  check(noted.status === 200 && !noted.changed && noted.notes?.length === 1 && /Widget "p95": left out data\.trend/.test(noted.notes[0]), "what was left out of a write comes back with it");
  const att = await claude.post("/attachments", { key: "lat", type: "metric", data: { value: 412, good: "higher" } });
  check(att.status === 400 && /Nothing was attached/.test(att.error) && /data\.good should be 'up' or 'down'/.test(att.error), "a thread's attachment is checked as a page's widget of its kind is");
  const att2 = await claude.post("/attachments", { key: "slo", type: "table", data: { columns: ["Service", "SLO"], rows: [{ Service: "api", SLO: "99.9%" }], extra: 1 } });
  check(att2.status === 200 && att2.notes?.length === 1 && /left out data\.extra/.test(att2.notes[0]), "and what was left out of it comes back");

  // ---------- only contributors change it ----------
  const refused = await codex.post("/pages", { page: id, widgets: [{ id: "graf", type: "link", title: "Grafana", data: { url: "https://grafana.example" } }] });
  check(refused.status === 403 && /isn't a contributor/.test(refused.error), "an agent that isn't a contributor can't change it");
  check((await alice.post(`/api/pages/${id}/contributors`, { agent: "codex" })).status === 404, "only its owner adds contributors (someone else can't even see it)");
  check((await owner.post(`/api/pages/${id}/contributors`, { agent: "codex" })).status === 200, "its owner adds an agent as a contributor");
  const v3 = await codex.post("/pages", { page: id, remove: ["slo"], widgets: [{ id: "graf", type: "link", title: "Grafana", data: { url: "https://grafana.example" } }] });
  check(v3.status === 200 && v3.version === 3, "a contributor agent changes it");

  // ---------- versions, and restoring one ----------
  let detail = await owner.get(`/api/pages/${id}`);
  check(detail.history.map((v) => v.v).join() === "3,2,1" && detail.history[0].summary === "Added Grafana, removed SLOs" && !("snapshot" in detail.history[0]), "its versions come newest first, summed up, without their copies of the page");
  check(detail.posts.length === 2 && detail.posts.find((x) => x.agent === "claude")?.versions === 2, "and the posts that changed it, with how many versions each");
  const old = await owner.get(`/api/pages/${id}/versions/2`);
  check(old.v === 2 && old.snapshot.widgets.some((w) => w.id === "slo"), "an older version shows the page as it was");
  const restored = await owner.post(`/api/pages/${id}/restore`, { v: 2 });
  check(restored.status === 200 && restored.version === 4, "restoring v2 saves it as v4");
  page = (await stateOf(owner.get)).pages.find((p) => p.id === id);
  check(page.last.restored === 2 && page.widgets.map((w) => w.id).join() === "p95,slo" && page.last.by.user === "herval", "the page is as it was at v2, and v4 says who restored it");
  check((await owner.post(`/api/pages/${id}/restore`, { v: 99 })).status === 404, "a version that isn't kept can't be restored");

  // ---------- who sees it, and people as contributors ----------
  check((await owner.post(`/api/pages/${id}/visibility`, { visibility: "public" })).status === 200, "its owner makes it public");
  check(!(await stateOf(alice.get)).pages.some((p) => p.id === id), "someone who isn't his contact doesn't see it");
  // Public is for his contacts; alice becomes one, and takes him off her feed, so she only
  // sees it.
  await alice.post("/api/people/herval/contact", { act: "ask" });
  await owner.post("/api/people/alice/contact", { act: "yes" });
  await alice.post("/api/people/herval/follow", { follow: false });
  const seen = (await stateOf(alice.get)).pages.find((p) => p.id === id);
  check(seen && !seen.mine && !seen.can_edit && seen.by.agent === null && seen.widgets.every((w) => !w.by?.agent), "his contact sees a public page, but not which private agent wrote what");
  check((await alice.post(`/api/pages/${id}/write`, { widgets: [{ id: "n", type: "note", data: { text: "hi" } }] })).status === 403, "they can't change it");
  check((await alice.post(`/api/pages/${id}/visibility`, { visibility: "private" })).status === 403, "or say who sees it");
  const followedBy = async (who) => (await stateOf(who.get)).pages.find((p) => p.id === id)?.followed;
  const pageOnFeed = async (who) => !!(await who.get("/api/q/feed?n=100")).list?.includes(`page:${id}`);
  check(seen.followed === false && !(await pageOnFeed(alice)) && (await pageOnFeed(owner)), "someone who only sees it, not following him, doesn't follow it: it's on its owner's feed, not theirs");
  check((await owner.post(`/api/pages/${id}/contributors`, { user: "alice" })).status === 200, "its owner adds a person as a contributor");
  check((await followedBy(alice)) === true && (await pageOnFeed(alice)), "a person on it follows it from then on: it's on their feed");
  const byHand = await alice.post(`/api/pages/${id}/write`, { widgets: [{ id: "n", type: "note", title: "Notes", data: { text: "Looks good." } }], order: ["n", "p95", "slo"] });
  check(byHand.status === 200 && byHand.version === 5, "a person who contributes changes it by hand");
  page = (await stateOf(owner.get)).pages.find((p) => p.id === id);
  check(page.widgets[0].id === "n" && page.last.hand && page.last.by.user === "alice", "their version is by hand, by them, in the order they gave");
  check((await alice.post(`/api/pages/${id}/contributors`, { agent: "claude", remove: true })).status === 403, "a contributor still can't say who else is one");
  check((await owner.post(`/api/pages/${id}/contributors`, { agent: "claude", remove: true })).status === 200 && (await stateOf(owner.get)).pages.find((p) => p.id === id).contributors.some((c) => c.agent === "claude"), "the agent that made it stays a contributor");

  // ---------- following: each person's own, and what puts a page on their feed ----------
  check((await followedBy(owner)) === true && (await followedBy(alice)) === true, "its owner follows it from the start, and so does a person who contributes to it");
  check((await alice.post("/api/follows", { page: id, followed: false })).status === 200 && (await followedBy(alice)) === false && !(await pageOnFeed(alice)) && (await followedBy(owner)) === true, "a contributor unfollows it, for themselves: it's off their feed");
  check((await alice.post("/api/follows", { page: id, followed: true })).status === 200 && (await followedBy(alice)) === true && (await pageOnFeed(alice)) && (await followedBy(owner)) === true, "they follow it again, for themselves");
  check((await owner.post("/api/follows", { page: id, followed: false })).status === 200 && (await followedBy(owner)) === false && (await followedBy(alice)) === true, "its owner unfollows it, and it stays followed for them");
  check((await alice.post("/api/follows", { page: "no-such-page", followed: true })).status === 404 && (await nobody.post("/api/follows", { page: id })).status === 401, "a page you can't see can't be followed, and signed out can't follow anything");
  await owner.post(`/api/pages/${id}/visibility`, { visibility: "private" });
  check((await alice.post("/api/follows", { page: id, followed: false })).status === 200, "a contributor follows or unfollows it once it's private too");
  check((await stateOf(alice.get)).pages.some((p) => p.id === id), "a contributor still sees it once it's private again");
  await owner.post(`/api/pages/${id}/contributors`, { user: "alice", remove: true });
  check(!(await stateOf(alice.get)).pages.some((p) => p.id === id), "taken off, they don't");

  // ---------- the answer says when the page repeats itself, and an agent can't take it past 30 widgets ----------
  const spend = await claude.post("/pages", {
    title: "Spend: platform",
    widgets: [
      { id: "total", type: "metric", title: "Card spend, October", data: { value: "$162.7k" } },
      { id: "vendors", type: "table", title: "Monthly spend per vendor", data: { columns: ["Vendor", "Sep", "Oct"], rows: [["Ledgerly", "$12.4k", "$13.1k"], ["Hostly", "$40.8k", "$41.2k"], ["Mailo", "$1.25k", "$1.31k"], ["Tracey", "$8.75k", "$9.02k"]] } },
      { id: "sources", type: "note", title: "Sources and method", data: { text: "From the card export, pulled Nov 7." } },
    ],
  });
  check(spend.created && Array.isArray(spend.advice) && spend.advice.length === 0, "a small page that says each thing once gets nothing back about its shape");
  const twoSources = await claude.post("/pages", {
    page: spend.id,
    widgets: [
      { id: "cloud-sources", type: "note", title: "Cloud sources and method", data: { text: "From the cloud billing console." } },
      { id: "cloud-vendors", type: "table", title: "Spend by provider", data: { columns: ["Provider", "Sep", "Oct"], rows: [["Ledgerly", "$12.4k", "$13.1k"], ["Hostly", "$40.8k", "$41.2k"], ["Mailo", "$1.25k", "$1.31k"], ["Tracey", "$8.75k", "$9.02k"]] } },
    ],
  });
  check(twoSources.changed && twoSources.advice.some((l) => /sources \("Sources and method"\) and cloud-sources .* both say where the numbers come from/.test(l)), "a second sources note is named, with the first");
  check(twoSources.advice.some((l) => /cloud-vendors .* and vendors .* show 8 of the same numbers/.test(l)), "and a table that shows the numbers another one does");
  const log = "Oct 30: the cloud bill came in at $41.2k, as forecast, and the two vendors we cut stayed cut. ".repeat(3);
  await claude.post("/pages", { page: spend.id, widgets: [{ id: "log", type: "doc", title: "Log", data: { text: log } }] });
  const appended = await claude.post("/pages", { page: spend.id, widgets: [{ id: "log", data: { text: `${log}\n\nNov 6: ${"Mailo billed twice this month, both refunded on the 7th, so November looks higher than it is. ".repeat(3)}` } }] });
  check(appended.advice.some((l) => /log \("Log"\) grew from \d+ to \d+ characters by adding to what it said/.test(l)), "a doc that grew by being added to is told to say what's true now instead");
  const refresh = await claude.post("/pages", { page: spend.id, widgets: [{ id: "total", data: { value: "$163.0k" } }] });
  check(refresh.changed && refresh.advice.length === 0, "a refresh of a number that doesn't repeat anything is told nothing");
  const many = Array.from({ length: 14 }, (_, i) => ({ id: `m${i}`, type: "metric", title: `Service ${String.fromCharCode(97 + i)} cost`, data: { value: i } }));
  const grown = await claude.post("/pages", { page: spend.id, widgets: many });
  check(grown.changed && /It has 20 widgets now, 14 of them new in this write/.test(grown.advice[0]), "past 16 widgets, a write that adds some is asked to fold some in");
  const tooMany = await claude.post("/pages", { page: spend.id, widgets: Array.from({ length: 11 }, (_, i) => ({ id: `x${i}`, type: "metric", title: `Extra ${i}`, data: { value: i } })) });
  check(tooMany.status === 400 && /would give the page 31 widgets, and an agent can't take a page past 30/.test(tooMany.error) && (await claude.get(`/pages/${spend.id}`)).widgets.length === 20, "an agent can't take a page past 30 widgets, and nothing of that write is saved");
  check((await claude.post("/pages", { page: spend.id, remove: ["m0"], widgets: Array.from({ length: 11 }, (_, i) => ({ id: `x${i}`, type: "metric", title: `Extra ${i}`, data: { value: i } })) })).status === 200, "taking one off in the same write gets it to 30, which it can");
  check((await owner.post(`/api/pages/${spend.id}/write`, { widgets: [{ id: "h1", type: "note", title: "By hand", data: { text: "one" } }, { id: "h2", type: "note", title: "By hand too", data: { text: "two" } }] })).status === 200, "the person takes it past 30 by hand");
  check((await claude.post("/pages", { page: spend.id, widgets: [{ id: "total", data: { value: "$163.4k" } }] })).status === 200, "an agent still keeps a page that's past 30 up to date");
  check((await claude.post("/pages", { page: spend.id, widgets: [{ id: "y", type: "metric", title: "One more", data: { value: 1 } }] })).status === 400, "but doesn't make it bigger");
  check((await claude.post("/pages", { page: spend.id, remove: ["h1", "h2", "x0"] })).status === 200, "and can make it smaller");
  await owner.post(`/api/pages/${spend.id}/archive`, { archived: true });

  // ---------- by hand, from scratch ----------
  const blank = await owner.post("/api/pages", { title: "Reading list", emoji: "📚" });
  check(blank.status === 200 && blank.id === "reading-list" && (await stateOf(owner.get)).pages.find((p) => p.id === "reading-list")?.version === 1, "its owner starts a page by hand");
  const hers = await alice.post("/api/pages", { title: "Mine" });
  check(hers.status === 200 && (await stateOf(alice.get)).pages.find((p) => p.id === hers.id)?.mine && !(await stateOf(owner.get)).pages.some((p) => p.id === hers.id), "someone else starts one of their own, private to them");

  // ---------- a launch for a page ----------
  const launched = await owner.post("/api/launch", { prompt: "Add an error budget chart", agent: "codex", page: blank.id });
  check(launched.status === 200 || launched.status === 500, "a post can be started for a page");
  check((await stateOf(owner.get)).pages.find((p) => p.id === blank.id).contributors.some((c) => c.agent === "codex"), "and the agent it's for becomes a contributor");

  // ---------- a post written from a page knows the page, and keeps knowing it when it's written on again ----------
  fs.writeFileSync(path.join(FAKE, "next.txt"), "sess-page");
  const fromPage = await owner.post("/api/launch", { prompt: "Who keeps this up to date?", agent: "claude", page: id, root: project });
  await req("POST", "/api/hello", { body: { proc: "box-3", label: "kite", agent: "Claude", session_id: "sess-page", cwd: project } });
  const kite = agent("box-3");
  const ctx = (await kite.get("/context")).text || "";
  check(fromPage.status === 200 && /herval started this thread from the page "Reliability: platform" \(reliability-platform, http/.test(ctx), "a post written from a page is told which page \"this\" is");
  check(/Its widgets, by id: n \(/.test(ctx) && /p95 \("p95 latency", a number, 388 ms\)/.test(ctx) && /last changed just now by @alice, by hand: "Added Notes"/.test(ctx) && /Also open on it: osprey \(Claude\), "New thread"/.test(ctx) && /You contribute to it/.test(ctx), "and what's on it, who changed it last, the other posts on it, and that it can change it");
  check(/may be a question about it rather than a change/.test(ctx), "and that what it was asked may be a question, not a change");
  check((await owner.get(`/api/pages/${id}`)).posts.find((x) => x.post === "sess-page")?.versions === 0, "a thread started from a page is among its threads, though it changed nothing");
  await req("POST", "/api/hello", { body: { proc: "box-9", label: "wren", agent: "Claude", session_id: "sess-none", cwd: project } });
  const onFeed = (await stateOf(owner.get)).sessions;
  check(onFeed.find((x) => x.id === "sess-page")?.page === id && (await owner.get("/api/sessions/sess-page")).page === id && onFeed.find((x) => x.id === "sess-none")?.page === null, "and its thread says which page, on the feed and on its own; one that has nothing to do with a page says none");
  check(onFeed.find((x) => x.id === "sess-b")?.page === id && (await owner.get("/api/sessions/sess-b")).page === id, "a thread not started from a page that changed it says that page too, as the page counts it among its threads");
  await agent("box-9").post("/gone", { reason: "Ended" });
  const kiteRead = await kite.get(`/pages/${id}`);
  check(kiteRead.versions?.[0]?.v === kiteRead.version && kiteRead.versions.length === kiteRead.version && kiteRead.versions[0].by === "@alice, by hand" && kiteRead.versions.some((v) => v.by === 'osprey (Claude), in "New thread"' && v.summary === "Refreshed latency"), "ab_page_read says who made its latest versions, and what they changed");
  await kite.post("/gone", { reason: "Ended" });
  const written = await owner.post("/api/sessions/sess-page/messages", { text: "And add an error budget" });
  await req("POST", "/api/hello", { body: { proc: "box-4", label: "kite", agent: "Claude", session_id: "sess-page", cwd: project } });
  const resumed = (await stateOf(owner.get)).sessions.find((x) => x.id === "sess-page");
  // Ended, it resumes from a new launch; or, once Claude Code lists it as a background session, it slept and wakes.
  const wokeOrResumed = written.resumed ? resumed?.launch === written.lid : written.ok && !!resumed;
  check(wokeOrResumed && /started this thread from the page "Reliability: platform"/.test((await agent("box-4").get("/context")).text || ""), "written on again after it ended, it still knows the page");
  await agent("box-4").post("/gone", { reason: "Ended" });

  // ---------- naming its widgets ----------
  fs.writeFileSync(path.join(FAKE, "next.txt"), "sess-named");
  const named = await owner.post("/api/launch", { prompt: "Why did @p95 move? Compare it with @reading-list.", agent: "claude", page: id, root: project });
  const calls = fs.readFileSync(path.join(FAKE, "calls.jsonl"), "utf8").split("\n").slice(0, -1).map((l) => JSON.parse(l));
  const asked = calls.findLast((c) => c.env.AGENTBOOK_LAUNCH_ID === named.lid)?.args.join(" ") || "";
  check(asked.includes('Why did @reliability-platform/p95 move? Compare it with @reading-list.\n\nNamed:\n- @reliability-platform/p95: the widget "p95 latency" on the page "Reliability: platform": a number, 388 ms') && asked.includes('- @reading-list: the page "Reading list", 0 widgets'), "a thread started from a page gets its widgets named in full, and a note on each page and widget it names");
  await req("POST", "/api/hello", { body: { proc: "box-5", label: "ibis", agent: "Claude", session_id: "sess-named", cwd: project } });
  await owner.post("/api/sessions/sess-named/messages", { text: "And has @p95 come down since?" });
  const ibisGot = (await agent("box-5").get("/events")).events?.map((e) => e.event).find((e) => e.type === "message");
  const kept = (await owner.get("/api/sessions/sess-named")).messages?.find((m) => m.from === "human" && /come down/.test(m.text));
  check(kept?.text === "And has @reliability-platform/p95 come down since?" && ibisGot?.text.startsWith("And has @reliability-platform/p95 come down since?\n\nNamed:\n- @reliability-platform/p95: the widget"), "a reply on it keeps the widget named in full, and its agent gets the note; the thread keeps only what was written");
  await agent("box-5").post("/gone", { reason: "Ended" });

  // ---------- a page's checklist is the person's tasks ----------
  // A task is on any number of pages, as on any number of threads: { page, at, by } each.
  const onPg = (t, page) => !!t?.pages?.some((e) => e.page === page);
  const todoFirst = await claude.post("/todos", { text: "Review PR #12, the launch post", new: false });
  const launch = await claude.post("/pages", {
    title: "Launch",
    widgets: [{ id: "todo", type: "tasks", title: "What needs doing", data: { items: [{ text: "Submit the three listings", note: "10 min of copy-paste" }, { text: "Add IndexNow to the deploy", for: "me" }, { text: "Review PR #12, the launch post" }] } }],
  });
  const lid = launch.id;
  let mine = (await stateOf(owner.get)).tasks.filter((t) => onPg(t, lid));
  const listings = mine.find((t) => t.text === "Submit the three listings");
  const indexNow = mine.find((t) => t.text === "Add IndexNow to the deploy");
  check(launch.created && launch.tasks?.length === 3 && launch.tasks[0].added && launch.tasks[1].added, "an agent's tasks widget puts its items on the person's Tasks list");
  check((await stateOf(owner.get)).pages.find((x) => x.id === lid)?.widgets[0].type === "tasks" && JSON.stringify((await stateOf(owner.get)).pages.find((x) => x.id === lid).widgets[0].data) === "{}", "the widget keeps no items of its own");
  check(listings?.note === "10 min of copy-paste" && !listings.agent && indexNow?.agent === "claude" && listings.from === "sess-a" && listings.rank < indexNow.rank, "each is on the page, with its note, for the agent when it's its own, from its thread, in the order given");
  check(launch.tasks[2].joined && launch.tasks[2].id === todoFirst.id && mine.length === 3, "a to-do already on the list that looks the same joins the page instead of coming again");
  const again2 = await claude.post("/pages", { page: lid, widgets: [{ id: "todo", data: { items: [{ text: "Submit the three listings" }, { text: "Add IndexNow to the deploy", done: true }] } }] });
  mine = (await stateOf(owner.get)).tasks.filter((t) => onPg(t, lid));
  check(!again2.changed && again2.tasks?.[1].ticked && mine.length === 3 && mine.find((t) => t.id === indexNow.id).done_by === "agent", "written again, it's the same tasks: nothing added, and done: true ticks one off, as the agent");
  const checklist = await claude.post("/pages", { page: lid, widgets: [{ id: "more", type: "list", title: "Later", data: { check: true, items: [{ text: "Trim the meta descriptions", sub: "they're 172 to 217 characters" }] } }] });
  const trim = (await stateOf(owner.get)).tasks.find((t) => t.text === "Trim the meta descriptions");
  check(checklist.tasks?.[0].added && onPg(trim, lid) && trim.pages[0].by === "agent" && trim.note === "they're 172 to 217 characters" && (await stateOf(owner.get)).pages.find((x) => x.id === lid).widgets.find((w) => w.id === "more")?.type === "tasks", "a list written as a checklist is tasks too, its line under each its note");
  const relisted = await claude.post("/pages", { page: lid, widgets: [{ id: "more", type: "list", data: { items: [{ text: "Trim the meta descriptions" }] } }] });
  check(!relisted.changed && relisted.tasks?.[0].id === trim.id && (await stateOf(owner.get)).pages.find((x) => x.id === lid).widgets.find((w) => w.id === "more")?.type === "tasks", "a tasks widget written again as a list stays tasks");
  await owner.post(`/api/tasks/${listings.id}/done`, { done: true });
  const undo = await claude.post("/pages", { page: lid, widgets: [{ id: "todo", data: { items: [{ id: listings.id, text: "Submit the three listings", done: false }, { id: indexNow.id, text: "Add IndexNow on every deploy", done: false }, { id: "k-nope", text: "?" }] } }] });
  mine = (await stateOf(owner.get)).tasks.filter((t) => onPg(t, lid));
  check(mine.find((t) => t.id === listings.id).done && !mine.find((t) => t.id === indexNow.id).done && undo.tasks?.[1].unticked, "it unticks what an agent ticked, never what the person did");
  check(mine.find((t) => t.id === indexNow.id).text === "Add IndexNow on every deploy" && undo.tasks?.[2].missing, "with an id, it renames the task; an id that's no task is said to be missing");
  const read2 = await claude.get(`/pages/${lid}`);
  const items = read2.widgets.find((w) => w.id === "todo")?.data.items || [];
  check(items.length === 4 && items.find((t) => t.id === indexNow.id)?.for === "me" && items.find((t) => t.id === listings.id)?.for === "you" && items.find((t) => t.id === listings.id)?.done && items.find((t) => t.id === trim.id)?.note, "ab_page_read lists the page's tasks in its tasks widget, with ids, notes, who each is for, and what's done");
  const byHand2 = await owner.post("/api/tasks", { text: "Email HN about the second chance", page: lid, note: "hn@ycombinator.com" });
  const stray = await owner.post("/api/tasks", { text: "Not on a page", page: "no-such-page" });
  const all2 = (await stateOf(owner.get)).tasks;
  check(onPg(all2.find((t) => t.id === byHand2.id), lid) && all2.find((t) => t.id === byHand2.id).note === "hn@ycombinator.com" && all2.find((t) => t.id === stray.id)?.pages.length === 0, "the person adds a task on a page they see, with a note; a page they don't see isn't one");
  await owner.post(`/api/tasks/${byHand2.id}`, { note: "" });
  check(!(await stateOf(owner.get)).tasks.find((t) => t.id === byHand2.id).note, "and clears its note");
  // Linking pages to a task by hand, as threads are: one more, the same one again, one they don't see, unlinking.
  const second = await claude.post("/pages", { title: "Launch, week two", widgets: [{ id: "n", type: "note", title: "Notes", data: { text: "After the launch." } }] });
  const linkPage = (id, body) => owner.post(`/api/tasks/${id}/page`, body);
  const l1 = await linkPage(byHand2.id, { page: second.id });
  await linkPage(byHand2.id, { page: second.id });
  const nope = await linkPage(byHand2.id, { page: "no-such-page" });
  const notYours = await alice.post(`/api/tasks/${byHand2.id}/page`, { page: second.id });
  let two = (await stateOf(owner.get)).tasks.find((t) => t.id === byHand2.id);
  check(l1.ok && two.pages.map((e) => e.page).join() === `${lid},${second.id}` && two.pages[1].by === "you" && nope.status === 404 && notYours.status === 404, "a task links to another page, once, in the order linked; not to a page they don't see, nor by someone else");
  const onSecond = (await claude.get(`/pages/${second.id}`)).widgets;
  const secondTasks = await claude.post("/pages", { page: second.id, widgets: [{ id: "todo", type: "tasks", title: "To do", data: { items: [{ text: "Email HN about the second chance" }] } }] });
  two = (await stateOf(owner.get)).tasks.find((t) => t.id === byHand2.id);
  check(onSecond && secondTasks.tasks?.[0].id === byHand2.id && !secondTasks.tasks[0].joined && two.pages.length === 2, "on the second page's checklist it's the same task, already there");
  const joins = await claude.post("/pages", { page: second.id, widgets: [{ id: "todo", data: { items: [{ text: "Email HN about the second chance" }, { id: trim.id, text: "Trim the meta descriptions" }] } }] });
  const trim2 = (await stateOf(owner.get)).tasks.find((t) => t.id === trim.id);
  check(joins.tasks?.[1].joined && joins.tasks[1].id === trim.id && onPg(trim2, lid) && onPg(trim2, second.id), "one on another page's checklist, written with its id, joins this one too, and stays on the other");
  await linkPage(byHand2.id, { page: lid, linked: false });
  two = (await stateOf(owner.get)).tasks.find((t) => t.id === byHand2.id);
  check(two.pages.map((e) => e.page).join() === second.id && !(await claude.get(`/pages/${lid}`)).widgets.find((w) => w.id === "todo")?.data.items.some((t) => t.id === byHand2.id), "unlinked, it's off that page's checklist");

  // ---------- a task is a title and a body ----------
  const taskOf = async (id) => (await stateOf(owner.get)).tasks.find((t) => t.id === id);
  const LONG = "Rotate the Stripe webhook secret in prod and staging, then update the Doppler config and redeploy the payments service";
  const rotate = await taskOf((await owner.post("/api/tasks", { text: LONG, note: "Ask Ana first" })).id);
  check(rotate.text === "Rotate the Stripe webhook secret in prod and staging, then update the Doppler…" && rotate.note === "…config and redeploy the payments service\n\nAsk Ana first", "a title too long for one is cut at a word with a …, and the rest goes on top of its body, after another …");
  await owner.post(`/api/tasks/${byHand2.id}`, { note: "hn@ycombinator.com" });
  await owner.post(`/api/tasks/${byHand2.id}`, { text: "Email HN about the second chance and the title, which is now long enough to need cutting" });
  const hn = await taskOf(byHand2.id);
  check(hn.text.length <= 80 && hn.text.endsWith("…") && hn.note === "…need cutting\n\nhn@ycombinator.com", "editing it into a long title puts the rest on top of the body it has");
  await owner.post(`/api/tasks/${byHand2.id}`, { text: "Email HN", note: "Just this" });
  check((await taskOf(byHand2.id)).note === "Just this" && (await taskOf(byHand2.id)).text === "Email HN", "and a short title with a body sent along keeps them as they are");
  const lines = await taskOf((await owner.post("/api/tasks", { text: "Renew the cert\nIt expires on the 30th." })).id);
  check(lines.text === "Renew the cert" && lines.note === "It expires on the 30th.", "a title's first line is the title, the rest the body");
  const longTodo = await claude.post("/todos", { text: "Approve the Apple developer account renewal for Acme before it lapses at the end of the month", note: "It's under Billing.", new: true });
  const todoTask = await taskOf(longTodo.id);
  check(todoTask.text.length <= 80 && todoTask.text.endsWith("…") && todoTask.note.startsWith("…") && todoTask.note.endsWith("\n\nIt's under Billing."), "an agent's to-do (ab_todo) gets a title and a body too");
  const longItem = await claude.post("/pages", { page: lid, widgets: [{ id: "todo", data: { items: [{ text: "Write the launch post for the blog, the newsletter and the three communities we picked last week", note: "Draft in the doc" }] } }] });
  const itemTask = await taskOf(longItem.tasks[0].id);
  check(longItem.tasks[0].added && itemTask.text.endsWith("…") && itemTask.text.length <= 80 && itemTask.note.endsWith("\n\nDraft in the doc"), "and so does a task an agent writes on a page");
  const again3 = await claude.post("/pages", { page: lid, widgets: [{ id: "todo", data: { items: [{ text: "Write the launch post for the blog, the newsletter and the three communities we picked last week", note: "Draft in the doc" }] } }] });
  check(again3.tasks[0].id === itemTask.id && !again3.tasks[0].added && !again3.tasks[0].changed, "written again, it's the same task, unchanged");
  check(!(await stateOf(alice.get)).tasks.length, "someone else gets none of them");

  // ---------- a widget of its own, in a frame of its own ----------
  const calc = await claude.post("/pages", { title: "Mortgage", widgets: [{ id: "calc", type: "html", title: "Payments", data: { html: "<p id=out>…</p>", js: "out.textContent = agentbook.data.rate", data: { rate: 3, note: "</script><script>alert(1)</script>" } } }, { id: "n", type: "note", data: { text: "Not a frame" } }] });
  const frame = async (who, p) => {
    const r = await fetch(URL + p, { headers: who ? { cookie: who } : {} });
    return { status: r.status, csp: r.headers.get("content-security-policy") || "", type: r.headers.get("content-type") || "", referrer: r.headers.get("referrer-policy"), text: await r.text() };
  };
  const fr = await frame(owner.cookie, `/api/pages/${calc.id}/frame/calc`);
  check(fr.status === 200 && /^text\/html/.test(fr.type) && fr.text.includes("<p id=out>…</p>") && fr.text.includes("out.textContent = agentbook.data.rate") && fr.text.includes("window.agentbook"), "a widget of its own is served as a document of its own: its html and js, with agentbook's part");
  check(/^sandbox allow-scripts;/.test(fr.csp) && !/allow-same-origin|allow-popups|allow-forms|allow-top/.test(fr.csp) && /default-src 'none'/.test(fr.csp) && !/connect-src/.test(fr.csp) && /img-src data: blob:/.test(fr.csp) && fr.referrer === "no-referrer", "sandboxed as no site, with no network: no fetch, no pictures or scripts from elsewhere, no popups or forms");
  check(fr.text.includes('"\\u003c/script>\\u003cscript>alert(1)\\u003c/script>"') && !fr.text.includes("</script><script>alert(1)"), "its data can't break out of the script tag it's in");
  check((await frame(owner.cookie, `/api/pages/${calc.id}/frame/n`)).status === 404 && (await frame(owner.cookie, `/api/pages/${calc.id}/frame/nope`)).status === 404, "only a widget of its own has a frame");
  check((await frame(alice.cookie, `/api/pages/${calc.id}/frame/calc`)).status === 404 && (await frame(null, `/api/pages/${calc.id}/frame/calc`)).status === 401, "someone who can't see the page can't see its frame");
  const calc2 = await claude.post("/pages", { page: calc.id, widgets: [{ id: "calc", data: { data: { rate: 4 } } }] });
  const calcPage = await owner.get(`/api/pages/${calc.id}`);
  check(calc2.version === 2 && calcPage.history[0].summary === "Changed Payments" && calcPage.widgets[0].v === 2, "new data for it makes a version");
  const then = await frame(owner.cookie, `/api/pages/${calc.id}/frame/calc?v=1`);
  const now2 = await frame(owner.cookie, `/api/pages/${calc.id}/frame/calc?v=2`);
  check(then.text.includes('"rate":3') && now2.text.includes('"rate":4') && (await frame(owner.cookie, `/api/pages/${calc.id}/frame/calc?v=7`)).status === 404, "its frame shows it as it was when it changed at a version, for an older version of the page");

  // ---------- deciding on a page, without editing it ----------
  const decide = await claude.post("/pages", { title: "Decide", widgets: [{ id: "asks", type: "list", title: "Waits for you", data: { items: [{ text: "Add IndexNow", ask: "ok" }, { text: "Push the monitor change", ask: "ok" }, { text: "Just a note" }] } }, { id: "layout", type: "options", title: "Layouts", data: { items: [{ name: "A tab", pick: true }, { name: "A sheet" }] } }] });
  const act = (who, body) => who.post(`/api/pages/${decide.id}/act`, body);
  const asks = async () => (await owner.get(`/api/pages/${decide.id}`)).widgets.find((w) => w.id === "asks").data.items;
  const claudePost = (await stateOf(owner.get)).sessions.find((x) => x.proc === "box-1")?.id;
  const okd = await act(owner, { widget: "asks", act: "ok", item: { i: 0, text: "Add IndexNow" } });
  let dp = await owner.get(`/api/pages/${decide.id}`);
  check(okd.status === 200 && okd.version === 2 && dp.last.summary === "OK'd “Add IndexNow”" && dp.last.hand && dp.last.by.user === "herval" && (await asks())[0].ok === true && (await asks())[0].ok_by === "herval", "its owner OKs what an item asks for, on the page: a version by them, said in words");
  check(okd.tell?.post === claudePost && /^I OK'd “Add IndexNow”, on the page “Decide”: http/.test(okd.tell.text), "and the answer names the thread that asked, with what to tell it");
  const no = await act(owner, { widget: "asks", act: "no", item: { i: 9, text: "Push the monitor change" } });
  check(no.status === 200 && (await asks())[1].ok === false && /^I said not now to “Push the monitor change”/.test(no.tell?.text || ""), "says not now, found by its words when the list moved");
  check((await act(owner, { widget: "asks", act: "ok", item: { i: 2, text: "Just a note" } })).status === 400 && (await act(owner, { widget: "asks", act: "ok", item: { text: "Gone" } })).status === 409 && (await act(owner, { widget: "layout", act: "ok", item: { text: "A tab" } })).status === 400, "what doesn't ask for an OK can't be OK'd; an item that's gone, or an act that doesn't fit, is refused");
  const picked = await act(owner, { widget: "layout", act: "pick", item: { i: 1, text: "A sheet" } });
  let opts = (await owner.get(`/api/pages/${decide.id}`)).widgets.find((w) => w.id === "layout").data.items;
  check(picked.status === 200 && opts[1].chosen === true && !opts[0].chosen && opts[0].pick === true && /^I picked “A sheet” in “Layouts”/.test(picked.tell?.text || ""), "picking an option marks yours, keeps the agent's recommendation, and tells the thread");
  await act(owner, { widget: "layout", act: "pick", item: { i: 0, text: "A tab" } });
  opts = (await owner.get(`/api/pages/${decide.id}`)).widgets.find((w) => w.id === "layout").data.items;
  const unpicked = await act(owner, { widget: "layout", act: "unpick", item: { i: 0, text: "A tab" } });
  check(opts[0].chosen === true && !opts[1].chosen && !unpicked.tell && !(await owner.get(`/api/pages/${decide.id}`)).widgets.find((w) => w.id === "layout").data.items.some((o) => o.chosen), "picking another moves the pick, and taking it back tells no one");
  check((await act(alice, { widget: "asks", act: "ok", item: { i: 0, text: "Add IndexNow" } })).status === 404 && (await req("POST", `/api/pages/${decide.id}/act`, { body: {} })).status === 401, "only who can change the page decides on it");

  // ---------- archiving a page's update off your feed: yours alone, until the page changes again ----------
  const card = await owner.post("/api/pages", { title: "Feed card", emoji: "🗂️" });
  const feedOf = async (who, filter = "") => (await who.get(`/api/q/feed?n=100${filter ? `&filter=${filter}` : ""}`)).list || [];
  const cardSeen = async () => (await stateOf(owner.get)).pages.find((x) => x.id === card.id);
  check((await feedOf(owner)).includes(`page:${card.id}`) && !(await cardSeen()).feed_archived, "a page you follow has its card on your feed");
  const archivedBefore = (await owner.get("/api/q/feed")).counts.states.archived;
  check((await owner.post("/api/feed/archive", { page: card.id })).status === 200 && !(await feedOf(owner)).includes(`page:${card.id}`) && !(await feedOf(owner, "pages")).includes(`page:${card.id}`), "archiving its update takes the card off your feed");
  const put = await cardSeen();
  check((await feedOf(owner, "archived")).includes(`page:${card.id}`) && put.feed_archived === true && !put.archived && put.followed === true, "it's under Archived, and the page itself is neither archived nor unfollowed");
  check((await owner.post("/api/feed/archive", { page: card.id, archived: false })).status === 200 && (await feedOf(owner)).includes(`page:${card.id}`) && !(await cardSeen()).feed_archived && !(await feedOf(owner, "archived")).includes(`page:${card.id}`), "unarchiving puts it back");
  await owner.post("/api/feed/archive", { page: card.id });
  const wrote = await owner.post(`/api/pages/${card.id}/write`, { widgets: [{ id: "n", type: "note", title: "Notes", data: { text: "Something new." } }] });
  check(wrote.status === 200 && (await feedOf(owner)).includes(`page:${card.id}`) && !(await cardSeen()).feed_archived, "the page changing brings its card back");
  check((await owner.post("/api/feed/archive", { page: "no-such-page" })).status === 404 && (await nobody.post("/api/feed/archive", { page: card.id })).status === 401 && (await alice.post("/api/feed/archive", { page: card.id })).status === 404, "a page you can't see can't be archived off a feed, and signed out archives nothing");
  await owner.post("/api/feed/archive", { page: card.id });
  check((await owner.get("/api/q/feed")).counts.states.archived === archivedBefore, "the Archived count stays the threads' own");

  // ---------- it all survives a restart ----------
  await sleep(500);
  await stop();
  // A task from before tasks had titles, its text long.
  const db = new DatabaseSync(path.join(HOME, "storage.db"));
  const oldRow = db.prepare("select data from tasks where scope = 'server' and id = ?").get(listings.id) as { data: string };
  // And one from when a task was on one page: `page`, no `pages`.
  const onePage = JSON.parse((db.prepare("select data from tasks where scope = 'server' and id = ?").get(indexNow.id) as { data: string }).data);
  delete onePage.pages;
  db.prepare("update tasks set data = ? where scope = 'server' and id = ?").run(JSON.stringify({ ...onePage, page: lid }), indexNow.id);
  db.prepare("update tasks set data = ? where scope = 'server' and id = ?").run(JSON.stringify({ ...JSON.parse(oldRow.data), text: "Submit the three listings to Product Hunt, Hacker News and the indie hackers forum, each with its own copy" }), listings.id);
  db.close();
  await start();
  const migrated = (await stateOf(owner.get)).tasks.find((t) => t.id === listings.id);
  const wasOne = (await stateOf(owner.get)).tasks.find((t) => t.id === indexNow.id);
  check(wasOne.pages?.length === 1 && wasOne.pages[0].page === lid && !("page" in wasOne), "a task from when it was on one page has that page as its pages");
  check(migrated.text === "Submit the three listings to Product Hunt, Hacker News and the indie hackers…" && migrated.note === "…forum, each with its own copy\n\n10 min of copy-paste", "a long task from before titles gets one once the server starts, the rest on top of its note");
  check((await feedOf(owner, "archived")).includes(`page:${card.id}`) && !(await feedOf(owner)).includes(`page:${card.id}`), "an archived update stays archived over a restart");
  const back = await owner.get(`/api/pages/${id}`);
  check(back.version === 5 && back.history.length === 5 && back.widgets[0].id === "n" && back.contributors.some((c) => c.agent === "codex"), "pages, their versions and contributors survive a restart");
  check((await stateOf(owner.get)).pages.find((p) => p.id === id)?.followed === false, "and so does unfollowing one");
  check((await stateOf(owner.get)).tasks.filter((t) => onPg(t, "launch")).length === 5 && (await stateOf(owner.get)).tasks.find((t) => t.text === "Trim the meta descriptions")?.note, "and so do a page's tasks, with their notes");
  const after = await claude.post("/pages", { page: id, widgets: [{ id: "p95", data: { value: 377 } }] });
  check(after.version === 6, "and versions carry on from there");
} catch (e) {
  console.error(e);
  failures++;
} finally {
  server?.kill("SIGTERM");
  fs.rmSync(HOME, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : "\nAll passed");
process.exit(failures ? 1 : 0);
