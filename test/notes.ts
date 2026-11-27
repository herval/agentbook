#!/usr/bin/env node
// Notes: a person writes one, a block at a time, kept as markdown; every change is a version.
// A comment that names an agent starts a thread for it about the note; the agent answers in the comment and
// suggests edits, which the person accepts or rejects. @ an agent in the text and it works at that line. A note lists
// every thread tied to it, and threads name notes with @note:<id>. Agents write only the notes they made. Notes, comments and
// suggestions survive a restart. Its owner shares one: who else reads it (private, followers, public), and the people
// on it, who work in it as its owner does, with the notes inside it. Run: node test/notes.ts

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { accept, critic, cutBlocks, inlineHtml, joinBlocks, overlay, parseBlocks, plainText, sliceBlocks } from "../plugin/shared/notes-md.ts";
import { applyNote } from "../plugin/shared/notes.ts";
import { MENTION, mentionNote } from "../plugin/shared/mentions.ts";
import type { State } from "../plugin/shared/types.ts";
import { type Agentbook, spawnAgentbook, testPort } from "./harness.ts";
import { stateOf } from "./harness-state.ts";
import type { Json } from "./harness-types.ts";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-notes-"));
fs.mkdirSync(path.join(HOME, "cli"), { recursive: true });
fs.writeFileSync(path.join(HOME, "cli", "gate.json"), JSON.stringify({ folders: [HOME], starts_per_hour: 1000 }));
const PORT = testPort(4600);
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
async function until(fn, ms = 4000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
    const v = await fn();
    if (v) return v;
  }
  return null;
}

// ---------- the parts that need no server ----------
{
  const md = "## Why now\n\nBefore it's **public**, 10–20 people\nshould use it _two weeks_.\n\n- one\n  - in\n- [x] done\n- [ ] @claude next\n1. first\n2. second\n\n> 💡 A callout.\n\n> a quote\n\n```js\nconst x = 1;\n```\n\n| a | b |\n|---|---|\n\n[📨 Invite](#/notes/invite)\n\n---\n\nLine one  \nline two\n";
  const blocks = parseBlocks(md);
  check(blocks.map((b) => b.t).join() === "h2,p,ul,ul,todo,todo,ol,ol,callout,quote,code,raw,sub,hr,p", "markdown becomes blocks: headings, paragraphs, lists, to-dos, callouts, quotes, code, tables, notes inside it, dividers");
  check(blocks[3].depth === 1 && blocks[4].done && !blocks[5].done && blocks[1].md.includes("people should") && blocks[14].md === "Line one\nline two", "a list item knows how far in it is, a to-do whether it's done; soft line breaks join, hard ones stay");
  const back = joinBlocks(blocks);
  check(joinBlocks(parseBlocks(back)) === back, "and blocks become the same markdown again");
  {
    // A selection across blocks (the page's noteCrossParts says what it takes in).
    const lines = parseBlocks("## Goals\n\nShip it on **Monday** morning.\n\n- Freeze prices\n- Check the ledger\n\n---\n\nTell support.\n");
    const cut = cutBlocks(lines, 0, 2, "Go", "ices");
    check(joinBlocks(cut) === "## Goices\n\n- Check the ledger\n\n---\n\nTell support.\n", "taking out a selection across blocks leaves its first block, with what's left of both ends");
    check(lines.length === 6, "and the blocks it came from are as they were, for undo");
    check(joinBlocks(cutBlocks(lines, 3, 5, "Check", "")) === "## Goals\n\nShip it on **Monday** morning.\n\n- Freeze prices\n- Check\n", "a divider inside it goes with it, and what's after it stays");
    check(joinBlocks(cutBlocks(lines, 0, lines.length - 1, "", "")).trim() === "##", "all of it leaves one empty block");
    check(sliceBlocks(lines, 0, 2, "oals", "Freeze") === "## oals\n\nShip it on **Monday** morning.\n\n- Freeze", "copied, it's the note's markdown, cut at its two ends");
    check(sliceBlocks(lines, 2, 5, "prices", "Tell") === "- prices\n- Check the ledger\n\n---\n\nTell", "with the blocks between it whole");
    check(joinBlocks(parseBlocks(sliceBlocks(lines, 0, 2, "oals", "Freeze"))).trim() === sliceBlocks(lines, 0, 2, "oals", "Freeze"), "and pasted back, it's the same blocks");
  }
  const laid = overlay(back, [{ id: "s1", find: "10–20 people", replace: "twenty people" }, { id: "s2", find: "not there", replace: "x" }]);
  check(laid.missing.join() === "s2" && /<del class="sg" data-s="s1">10–20 people<\/del><ins class="sg" data-s="s1">twenty people<\/ins>/.test(inlineHtml(parseBlocks(laid.md)[1].md)), "a suggestion is laid over its words for the page; one whose words aren't there isn't shown");
  check(critic(back, [{ id: "s1", find: "**public**", replace: "out" }]).md.includes("{~~**public**~>out~~}") && accept(back, { find: "first", replace: "1st" }).includes("1. 1st"), "an agent reads them as CriticMarkup; accepting one replaces its words");
  check(inlineHtml("a @claude b `@claude` [x](javascript:alert(1)) [y](https://e.com)", { chip: (t) => (t === "claude" ? "<CHIP>" : null) }) === 'a <CHIP> b <code>@claude</code> [x](javascript:alert(1)) <a href="https://e.com">y</a>', "a token is a chip only where it names something, never in code, and only web links are links");
  check(plainText("## A\n\n**b** [c](https://x)").trim() === "A\nb c", "a note's plain words leave its markdown out");
  check(inlineHtml("see @note:soft-launch and @ws:abc1 or @note:", { chip: (t) => (t.includes(":") ? `<${t}>` : null) }) === "see <note:soft-launch> and <ws:abc1> or @note:", "a note or a workspace named in a note's words is a token too");
  const about = "look at @note:soft-launch, then @note:nope and @soft-launch";
  check(mentionNote(about, {}, 0, {}, { notes: { "soft-launch": { id: "soft-launch", title: "Soft launch", whose: "@alice" } } }) === `Named:\n- @note:soft-launch: the note "Soft launch", @alice's on agentbook (ab_note_read with note "soft-launch" reads it)`, "a note named in a message is told to its agent, whose it is and how to read it; one that isn't there isn't");
  check(![...about.matchAll(MENTION)].some((m) => m[2] === "note"), "and @note:<id> is never a page named note");

  const s: Pick<State, "notes" | "note_versions"> = { notes: {}, note_versions: [] };
  const at = (m: number) => `2026-10-17T10:${String(m).padStart(2, "0")}:00.000Z`;
  applyNote(s, { t: "note.create", nid: "n", title: "N", text: "a", by: { user: "h" }, hand: true }, at(0));
  for (const [m, text] of [[1, "ab"], [2, "abc"], [3, "abcd"]] as const) applyNote(s, { t: "note.write", nid: "n", text, by: { user: "h" }, hand: true }, at(m));
  check(s.notes.n.version === 2 && s.note_versions.length === 2 && s.note_versions[1].text === "abcd", "your edits a few minutes apart are one version");
  applyNote(s, { t: "note.write", nid: "n", text: "abcde", by: { user: "h" }, hand: true }, at(20));
  check(s.notes.n.version === 3, "and an edit after a pause is the next one");
}

try {
  await start();
  const owner = as((await req("POST", "/api/auth/test-person", { body: { username: "herval" } })).cookie);
  const alice = as((await req("POST", "/api/auth/test-person", { body: { username: "alice" } })).cookie);
  await req("POST", "/api/hello", { body: { proc: "box-1", label: "osprey", agent: "Claude", session_id: "sess-a", cwd: project } });
  const claude = agent("box-1");

  // ---------- you write a note ----------
  const made = await owner.post("/api/notes", { title: "Soft launch: the first 20", emoji: "🚀", text: "## Why now\n\nBefore it's public, 10–20 people should use it for two weeks." });
  check(made.status === 200 && made.id === "soft-launch-the-first-20", "a note's id comes from its title");
  const id = made.id;
  let note = await owner.get(`/api/notes/${id}`);
  check(note.version === 1 && note.emoji === "🚀" && /10–20 people/.test(note.text) && note.comments.length === 0, "it's v1, with its markdown");
  const side = (await stateOf(owner.get)).notes;
  check(side.length === 1 && side[0].id === id && side[0].start.startsWith("Why now · Before it's public") && !("text" in side[0]), "the page's chrome lists it with how it starts, not its whole text");
  check((await alice.get(`/api/notes/${id}`)).status === 404 && !(await stateOf(alice.get)).notes.length, "nobody else sees it");
  const w = await owner.post(`/api/notes/${id}/write`, { text: note.text + "\n\n- Who: people who run agents every day", base: 1 });
  check(w.status === 200 && w.version === 2, "writing it makes v2");
  check((await owner.post(`/api/notes/${id}/write`, { text: note.text + "\n\n- Who: people who run agents every day, on two machines", base: 2 })).version === 2, "and what you write right after is the same version");
  const inside = await owner.post("/api/notes", { title: "Invite email", parent: id });
  check((await owner.get(`/api/notes/${inside.id}`)).parent === id, "a note can go inside another");
  check((await owner.post(`/api/notes/${id}/write`, { parent: inside.id })).status === 400, "but not inside one that's inside it");

  // ---------- agents: read, write their own, not yours ----------
  const list = await claude.get("/notes");
  check(list.notes?.length === 2 && list.notes.some((n) => n.id === id && !n.yours), "ab_note_list lists the person's notes");
  const read = await claude.get(`/notes/${id}`);
  check(read.text?.includes("two machines") && !read.yours && read.person === "herval", "ab_note_read gives its markdown, and whose it is");
  const nope = await claude.post("/notes", { note: id, text: "# Mine now" });
  check(nope.status === 403 && /suggest edits with ab_note_suggest/.test(nope.error), "an agent can't write a note the person wrote");
  const own = await claude.post("/notes", { title: "Eng sync, weekly", text: "## Oct 13\n\n- retries" });
  check(own.created && (await claude.post("/notes", { note: own.id, text: "## Oct 13\n\n- retries\n- the Datadog contract" })).version === 2, "it makes notes of its own, and writes them");
  check((await owner.get(`/api/notes/${own.id}`)).made, "a note an agent made says so");

  // ---------- a comment that names an agent starts a thread for it ----------
  fs.writeFileSync(path.join(FAKE, "next.txt"), "sess-note");
  const asked = await owner.post(`/api/notes/${id}/comments`, { cid: "cabc1234", mid: "mabc1234", quote: "10–20 people", nth: 0, text: "@Claude is two weeks enough?", to: { agent: "claude" } });
  check(asked.status === 200 && asked.comment === "cabc1234" && asked.lid, "a comment naming an agent starts a thread for it");
  const calls = fs.readFileSync(path.join(FAKE, "calls.jsonl"), "utf8").split("\n").slice(0, -1).map((l) => JSON.parse(l));
  const call = calls.findLast((c) => c.args.some((a) => /two weeks enough/.test(a)));
  const prompt = call?.args.find((a) => /two weeks enough/.test(a)) || "";
  check(/asked you this in a comment on their note "Soft launch: the first 20"/.test(prompt) && /comment "cabc1234"/.test(prompt) && /on these words: "10–20 people"/.test(prompt) && /ab_note_suggest/.test(prompt), "its agent is told which note, which comment, the words it's on, and how to answer and suggest");
  check(call && call.cwd.endsWith(path.join("notes", id)), "it works in a folder of the note's own on its machine");
  await req("POST", "/api/hello", { body: { proc: "box-5", label: "kite", agent: "Claude", session_id: "sess-note", cwd: call?.cwd || project } });
  note = await until(async () => {
    const n = await owner.get(`/api/notes/${id}`);
    return n.comments?.[0]?.thread === "sess-note" ? n : null;
  });
  check(note?.comments[0].launch && note.comments[0].thread === "sess-note", "the comment knows its thread once it starts");
  check((await stateOf(owner.get)).notes.find((n) => n.id === id)?.threads.includes("sess-note"), "and the list says which threads its comments talk to");

  // ---------- the agent answers and suggests ----------
  const kite = agent("box-5");
  const reply = await kite.post(`/notes/${id}/comment`, { comment: "cabc1234", text: "Enough to see where setup breaks." });
  check(reply.status === 200 && reply.comment === "cabc1234", "ab_note_comment replies in the comment");
  check((await kite.post(`/notes/${id}/suggest`, { find: "nowhere in it", replace: "x", comment: "cabc1234" })).status === 400, "a suggestion for words the note doesn't have is refused");
  check((await kite.post(`/notes/${id}/suggest`, { find: "Why now\n\nBefore", replace: "x" })).status === 400, "and one across lines");
  const sug = await kite.post(`/notes/${id}/suggest`, { find: "for two weeks", replace: "for two weeks, then four", comment: "cabc1234", why: "Keep them on after." });
  check(sug.status === 200 && sug.comment === "cabc1234" && sug.suggestion, "ab_note_suggest suggests an edit in the comment it answers");
  const own2 = await kite.post(`/notes/${id}/suggest`, { find: "## Why now", replace: "## Why we're doing this now" });
  check(own2.status === 200 && own2.comment !== "cabc1234", "one with no comment starts a comment of its own on its words");
  note = await owner.get(`/api/notes/${id}`);
  const c1 = note.comments.find((c) => c.id === "cabc1234");
  check(c1.msgs.length === 3 && c1.msgs[1].by.post === "sess-note" && c1.msgs[2].sugg === sug.suggestion && c1.msgs[2].text === "Keep them on after.", "the comment has your question, its answer, and its suggestion with why");
  check(note.comments.find((c) => c.id === own2.comment)?.quote === "Why now", "a comment of its own is on the words as they read");
  check(!note.text.includes("then four") && (await claude.get(`/notes/${id}`)).text.includes("{~~for two weeks~>for two weeks, then four~~}"), "a suggestion isn't in the note until it's accepted; agents read it as CriticMarkup");

  // ---------- you accept one, reject another ----------
  const v = note.version;
  const kept = await owner.post(`/api/notes/${id}/suggestions/${sug.suggestion}`, { keep: true });
  note = await owner.get(`/api/notes/${id}`);
  check(kept.status === 200 && note.text.includes("for two weeks, then four") && note.version === v + 1 && note.last.accepted?.sid === sug.suggestion, "accepting puts it in the note, as a version that says whose suggestion it was");
  check((await owner.post(`/api/notes/${id}/write`, { text: "stale", base: v })).status === 409, "writing over it from before it went in is refused, so it isn't undone");
  check((await owner.post(`/api/notes/${id}/suggestions/${own2.suggestion}`, { keep: false })).status === 200 && (await owner.get(`/api/notes/${id}`)).suggestions.find((x) => x.id === own2.suggestion).state === "undone", "rejecting one drops it");
  check((await owner.post(`/api/notes/${id}/suggestions/${own2.suggestion}`, { keep: true })).status === 409, "and it can't go in after that");
  const own3 = await kite.post(`/notes/${id}/suggest`, { find: "on two machines", replace: "on two machines or more" });
  await owner.post(`/api/notes/${id}/suggestions/${own3.suggestion}`, { keep: true });
  check((await owner.get(`/api/notes/${id}`)).comments.find((c) => c.id === own3.comment)?.quote === "on two machines or more", "accepted, its comment moves onto the words it put in, so it stays beside them");

  // ---------- replying in the comment talks to its thread ----------
  const r2 = await owner.post(`/api/notes/${id}/comments/cabc1234`, { mid: "mreply1234", text: "And after four weeks?" });
  check(r2.status === 200, "a reply in the comment goes to its thread");
  const heard = await until(async () => {
    const ev = await kite.get("/events");
    return (ev.events || []).find((e) => /And after four weeks\?/.test(e.event?.text || "")) || null;
  });
  check(heard && /A reply in comment cabc1234/.test(heard.event.text), "its agent hears it, with which comment it's in");
  check((await owner.post(`/api/notes/${id}/comments/cabc1234`, { mid: "mreply1234", text: "And after four weeks?" })) && (await owner.get(`/api/notes/${id}`)).comments.find((c) => c.id === "cabc1234").msgs.filter((m) => m.id === "mreply1234").length === 1, "sending the same reply again (signed this time) doesn't say it twice");
  const wsp = await owner.post("/api/workspaces", { folder: { path: project } });
  await owner.post(`/api/notes/${id}/comments/cabc1234`, { mid: "mreply5678", text: `Is that in @ws:${wsp.id}?` });
  const named = await until(async () => ((await kite.get("/events")).events || []).find((e) => /Is that in @ws:/.test(e.event?.text || "")) || null);
  const said = named?.event.text || "";
  check(said.includes(`\n\nNamed:\n- @ws:${wsp.id}: the workspace "app", the folder `) && said.includes(`${project} on `) && /A reply in comment cabc1234/.test(said), "a workspace named in a comment comes to its agent with where it is, as in a message");
  const plain = await owner.post(`/api/notes/${id}/comments`, { quote: "Who", text: "maybe 30?" });
  check(plain.status === 200 && !(await owner.get(`/api/notes/${id}`)).comments.find((c) => c.id === plain.comment).launch, "a comment naming no agent is just a comment");
  await claude.post(`/notes/${id}/comment`, { comment: plain.comment, text: "30 leaves room for questions." });
  check((await owner.get(`/api/notes/${id}`)).comments.find((c) => c.id === plain.comment).thread === "sess-a", "an agent that answers a comment with no thread becomes its thread, so your replies go to it");
  check((await owner.post(`/api/notes/${id}/comments/${plain.comment}/resolve`, {})).status === 200 && (await owner.get(`/api/notes/${id}`)).comments.find((c) => c.id === plain.comment).resolved, "and you resolve it");
  const tied = (await stateOf(owner.get)).notes.find((n) => n.id === id);
  check(tied.linked.includes("sess-note") && tied.linked.includes("sess-a") && !tied.threads.includes("sess-a"), "a note says every thread it's tied to, one whose comment is resolved too, so the thread can name it");
  check((await alice.post(`/api/notes/${id}/comments`, { text: "hi" })).status === 404, "nobody else comments on it");

  // ---------- @ an agent in the text: it works at that point ----------
  await owner.post(`/api/notes/${id}/write`, { text: (await owner.get(`/api/notes/${id}`)).text + "\n\n## Pricing\n\n@claude add the plan table\n\nThe end." });
  fs.writeFileSync(path.join(FAKE, "next.txt"), "sess-spot");
  const spot = await owner.post(`/api/notes/${id}/comments`, { cid: "cspot1234", mid: "mspot1234", quote: "@Claude add the plan table", nth: 0, spot: "@claude add the plan table", text: "@Claude add the plan table", to: { agent: "claude" } });
  check(spot.status === 200 && spot.lid, "an agent @'d in the text is asked, as a comment on its line");
  const spotCall = fs.readFileSync(path.join(FAKE, "calls.jsonl"), "utf8").split("\n").slice(0, -1).map((l) => JSON.parse(l)).findLast((c) => c.args.some((a) => /add the plan table/.test(a)));
  const told = spotCall?.args.find((a) => /add the plan table/.test(a)) || "";
  check(/@-mentioned you in the text of their note/.test(told) && /in this line of its markdown: @claude add the plan table/.test(told) && /find: that line exactly/.test(told), "it's told the line, and to put what it writes there with ab_note_suggest");
  await req("POST", "/api/hello", { body: { proc: "box-6", label: "ibis", agent: "Claude", session_id: "sess-spot", cwd: spotCall?.cwd || project } });
  const ibis = agent("box-6");
  check(await until(async () => (await owner.get(`/api/notes/${id}`)).comments.find((c) => c.id === "cspot1234")?.thread === "sess-spot"), "its comment knows its thread once it starts");
  check(((await ibis.get(`/notes/${id}`)).comments || []).find((c) => c.id === "cspot1234")?.spot === "@claude add the plan table", "ab_note_read says which line it was asked at");
  const atSpot = await ibis.post(`/notes/${id}/suggest`, { find: "@claude add the plan table", replace: "| Plan | Price |\n\nThree plans, from $10.", comment: "cspot1234" });
  check(atSpot.status === 200, "its suggestion can be that line, @ and all");
  await owner.post(`/api/notes/${id}/suggestions/${atSpot.suggestion}`, { keep: true });
  note = await owner.get(`/api/notes/${id}`);
  const onIt = note.comments.find((c) => c.id === "cspot1234");
  check(!note.text.includes("@claude") && note.text.includes("Three plans, from $10.") && onIt.quote === "Three plans, from $10." && !onIt.spot, "accepted, what it wrote is in the note where you asked, and the comment moves onto it");

  // ---------- every thread tied to a note, for its Threads box ----------
  const howOf = async (t) => (await owner.get(`/api/notes/${id}`)).ties.find((x) => x.id === t)?.how;
  check((await howOf("sess-note")) === "comment" && (await howOf("sess-spot")) === "comment", "a thread that talks to one of its comments is tied to it");
  await req("POST", "/api/hello", { body: { proc: "box-7", label: "wren", agent: "Claude", session_id: "sess-read", cwd: project } });
  const wren = agent("box-7");
  check(!(await howOf("sess-read")), "a thread that hasn't touched it isn't");
  await wren.get(`/notes/${id}`);
  check((await until(async () => (await howOf("sess-read")) === "read")) && !(await stateOf(owner.get)).notes.find((n) => n.id === id).linked.includes("sess-read"), "one that reads it is listed, without the note saying the thread is about it");
  const readRefs = (await owner.get(`/api/notes/${id}`)).rev;
  await wren.get(`/notes/${id}`);
  check((await owner.get(`/api/notes/${id}`)).rev === readRefs, "reading it again changes nothing");
  fs.writeFileSync(path.join(FAKE, "next.txt"), "sess-named");
  const started = await owner.post("/api/launch", { agent: "claude", root: project, prompt: `Sum up @note:${id} for me` });
  check(started.status === 200 && started.lid, "a thread started naming a note starts");
  const namedCall = fs.readFileSync(path.join(FAKE, "calls.jsonl"), "utf8").split("\n").slice(0, -1).map((l) => JSON.parse(l)).findLast((c) => c.args.some((a) => /Sum up @note:/.test(a)));
  check(namedCall?.args.some((a) => a.includes(`- @note:${id}: the note "Soft launch: the first 20" on agentbook (ab_note_read with note "${id}" reads it)`)), "and its agent is told what it names, and how to read it");
  await req("POST", "/api/hello", { body: { proc: "box-8", label: "tern", agent: "Claude", session_id: "sess-named", cwd: namedCall?.cwd || project } });
  check(await until(async () => (await howOf("sess-named")) === "named"), "it's tied to the note, once it has started");
  const bare = await owner.get(`/api/notes/${id}`);
  check(bare.thread_rows.some((r) => r.id === "sess-named" && r.label) && (await stateOf(owner.get)).notes.find((n) => n.id === id).linked.includes("sess-named"), "the note brings a row of each, and a thread that names it says so too");
  check(new Set(bare.ties.map((t) => t.id)).size === bare.ties.length, "each once");
  await owner.post("/api/sessions/sess-read/messages", { text: `Now look at @note:${id} again` });
  check((await until(async () => (await howOf("sess-read")) === "named")), "a thread that read it and then names it, in a message, is listed as naming it");
  const talk = await owner.post("/api/talks", { text: `For @note:${id}` });
  check(talk.status === 200 && (await owner.get(`/api/notes/${id}`)).ties.some((t) => t.id === talk.id && t.how === "named") && (await owner.get(`/api/notes/${id}`)).thread_rows.some((r) => r.id === talk.id), "and so is a thread of yours");
  const made2 = await wren.post("/notes", { title: "Wren's", text: "Its own." });
  check((await owner.get(`/api/notes/${made2.id}`)).ties.find((t) => t.id === "sess-read")?.how === "wrote", "a thread that wrote a note is tied to it");

  // ---------- it all survives a restart ----------
  await sleep(500);
  await stop();
  await start();
  note = await owner.get(`/api/notes/${id}`);
  check(note.text.includes("then four") && note.comments.length === 5 && note.suggestions.length === 4 && note.versions.length === note.version, "notes, their comments, suggestions and versions survive a restart");
  check(note.ties.find((t) => t.id === "sess-read")?.how === "named" && note.ties.some((t) => t.id === "sess-named"), "and so does which threads are tied to them");
  check((await owner.post(`/api/notes/${id}/write`, { text: note.text + "\n\nMore.", base: note.version })).version === note.version + 1, "and versions carry on from there");

  // ---------- sharing it: who else sees it, and who's on it ----------
  const bob = as((await req("POST", "/api/auth/test-person", { body: { username: "bob" } })).cookie);
  // Public is for herval's contacts, and only a contact goes on something of his.
  const contacts = async (a: ReturnType<typeof as>, aName: string, b: ReturnType<typeof as>, bName: string) => {
    await a.post(`/api/people/${bName}/contact`, { act: "ask" });
    await b.post(`/api/people/${aName}/contact`, { act: "yes" });
  };
  check((await req("GET", `/api/notes/${id}`)).status === 401, "signed out, nobody sees a note");
  check((await alice.post(`/api/notes/${id}/visibility`, { visibility: "public" })).status === 404, "someone it isn't shared with can't say who sees it");
  check((await owner.post(`/api/notes/${id}/visibility`, { visibility: "everyone" })).status === 400 && (await owner.post(`/api/notes/${id}/visibility`, { visibility: "followers" })).status === 400, "who sees it is private or public");
  check((await owner.post(`/api/notes/${id}/visibility`, { visibility: "public" })).status === 200, "its owner makes it public");
  check((await bob.get(`/api/notes/${id}`)).status === 404, "someone who isn't his contact doesn't see it");
  await contacts(bob, "bob", owner, "herval");
  let theirs = await bob.get(`/api/notes/${id}`);
  check(theirs.status === 200 && theirs.mine === false && theirs.can_edit === false && theirs.owner_name === "herval" && theirs.visibility === "public" && theirs.text.includes("then four"), "then his contact reads it, as someone else's they can't change");
  check((await stateOf(bob.get)).notes.some((n) => n.id === id && n.mine === false && n.owner_name === "herval"), "it's in their Notes, saying whose");
  check(theirs.workspace === null && theirs.comments.every((c) => c.launch === null), "they don't see where its agents work");
  check((await bob.post(`/api/notes/${id}/write`, { text: "mine", base: theirs.version })).status === 403 && (await bob.post(`/api/notes/${id}/comments`, { text: "hi" })).status === 403, "a reader can't write in it or comment");
  check((await bob.post(`/api/notes/${id}/visibility`, { visibility: "private" })).status === 403 && (await bob.post(`/api/notes/${id}/people`, { user: "bob" })).status === 403 && (await bob.post(`/api/notes/${id}/archive`, {})).status === 403, "nor say who sees it, who's on it, or archive it");
  await owner.post(`/api/notes/${id}/visibility`, { visibility: "private" });
  check((await bob.get(`/api/notes/${id}`)).status === 404 && !(await stateOf(bob.get)).notes.length, "private again, it's gone for them");

  check((await owner.post(`/api/notes/${id}/people`, { user: "nobody" })).status === 404 && (await owner.post(`/api/notes/${id}/people`, { user: "herval" })).status === 400, "only someone with an account, not its owner, goes on it");
  check((await owner.post(`/api/notes/${id}/people`, { user: "@alice" })).status === 409, "someone who isn't his contact doesn't go on it");
  await contacts(owner, "herval", alice, "alice");
  check((await owner.post(`/api/notes/${id}/people`, { user: "@alice" })).status === 200, "its owner puts a contact on it");
  const hers = await alice.get(`/api/notes/${id}`);
  check(hers.status === 200 && hers.mine === false && hers.can_edit === true && hers.people.some((p) => p.user === "alice" && !p.from), "they see it and may work in it");
  check(hers.ties.some((t) => t.id === "sess-note") && !hers.ties.some((t) => t.id === "sess-named" || t.id === "sess-read") && !hers.thread_rows.some((r) => r.id === "sess-named"), "its Threads shows them its comments' threads, not a private thread that only names it");
  const sub = await alice.get(`/api/notes/${inside.id}`);
  check(sub.status === 200 && sub.can_edit && sub.people.find((p) => p.user === "alice")?.from === id, "and the notes inside it, through it");
  check((await owner.post(`/api/notes/${inside.id}/people`, { user: "alice", remove: true })).status === 400, "who's on it through a note it's inside of comes off there");
  check((await stateOf(alice.get)).sessions.some((s) => s.id === "sess-note") && !(await stateOf(alice.get)).sessions.some((s) => s.id === "sess-named"), "the threads its comments talk to show to the people on it, and one that only names it doesn't");
  const kid = await alice.post("/api/notes", { title: "Who to ask", parent: id });
  const kidNote = await owner.get(`/api/notes/${kid.id}`);
  check(kid.status === 200 && kidNote.owner === hers.owner && kidNote.parent === id && (await alice.get(`/api/notes/${kid.id}`)).can_edit, "a note they make inside it is its owner's, and they're on it through it");
  const wrote = await alice.post(`/api/notes/${id}/write`, { text: hers.text + "\n\nFrom Alice.", base: hers.version });
  check(wrote.status === 200 && (await owner.get(`/api/notes/${id}`)).last.by.user === "alice", "they write in it, as a version of theirs");
  const ac = await alice.post(`/api/notes/${id}/comments`, { quote: "From Alice", text: "Mine to add?" });
  check(ac.status === 200 && (await owner.get(`/api/notes/${id}`)).comments.some((c) => c.id === ac.comment && c.msgs[0].by.user === "alice"), "they comment");
  check((await alice.post(`/api/notes/${id}/comments/${ac.comment}/resolve`, {})).status === 200, "and resolve comments");
  check((await alice.post(`/api/notes/${id}/comments/cabc1234`, { text: "Alice: and after six?" })).status === 200, "a reply in a comment whose thread is someone else's is kept");
  await sleep(600);
  check(!((await kite.get("/events")).events || []).some((e) => /after six/.test(e.event?.text || "")), "but isn't sent to their agent: only its owner gives it work");
  check((await alice.post(`/api/notes/${id}/comments`, { text: "@Claude?", to: { agent: "claude" } })).status === 403, "nor does naming their agent");
  check((await alice.post(`/api/notes/${id}/write`, { parent: null })).status === 200 && (await alice.post(`/api/notes/${inside.id}/write`, { parent: null })).status === 403, "they can't move it");
  check((await alice.post(`/api/notes/${id}/archive`, {})).status === 403 && (await alice.post(`/api/notes/${id}/visibility`, { visibility: "public" })).status === 403 && (await alice.post(`/api/notes/${id}/people`, { user: "bob" })).status === 403, "or archive it, say who sees it, or who's on it");
  check((await bob.get(`/api/notes/${id}`)).status === 404, "someone not on it still doesn't see it");
  check((await alice.post(`/api/notes/${id}/leave`, {})).status === 200 && (await alice.get(`/api/notes/${id}`)).status === 404 && (await alice.get(`/api/notes/${inside.id}`)).status === 404, "leaving it, it's gone for them, and the notes inside it too");
  check(!(await stateOf(alice.get)).sessions.some((s) => s.id === "sess-note"), "and so are its comments' threads");

  // ---------- an agent and someone else's note ----------
  const hersToo = await alice.post("/api/notes", { title: "Alice's plan", text: "We ship on Friday." });
  check(!(await claude.get("/notes")).notes.some((n) => n.id === hersToo.id) && (await claude.get(`/notes/${hersToo.id}`)).status === 404, "an agent doesn't see notes its person doesn't");
  await alice.post(`/api/notes/${hersToo.id}/visibility`, { visibility: "public" });
  const seen = (await claude.get("/notes")).notes.find((n) => n.id === hersToo.id);
  check(seen?.owner === "@alice" && seen.can_comment === false, "a public one is in ab_note_list, saying whose and that it may only read it");
  const rd = await claude.get(`/notes/${hersToo.id}`);
  check(rd.text === "We ship on Friday." && rd.person === "alice" && rd.can_comment === false, "it reads it");
  const no = await claude.post(`/notes/${hersToo.id}/comment`, { text: "Friday works." });
  check(no.status === 403 && /isn't on "Alice's plan"/.test(no.error) && (await claude.post(`/notes/${hersToo.id}/suggest`, { find: "Friday", replace: "Monday" })).status === 403, "but doesn't comment or suggest in it");
  await alice.post(`/api/notes/${hersToo.id}/people`, { user: "herval" });
  const sg = await claude.post(`/notes/${hersToo.id}/suggest`, { find: "Friday", replace: "Monday", why: "Fridays break." });
  check(sg.status === 200 && (await alice.get(`/api/notes/${hersToo.id}`)).suggestions.some((x) => x.id === sg.suggestion), "once its person is on it, it suggests in it, for the people on it to accept");
  check((await claude.post("/notes", { note: hersToo.id, text: "x" })).status === 403, "and still writes only the notes it made");
} catch (e) {
  console.error(e);
  failures++;
} finally {
  server?.kill("SIGTERM");
  fs.rmSync(HOME, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : "\nAll passed");
process.exit(failures ? 1 : 0);
