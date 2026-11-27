#!/usr/bin/env node
// How a turn went: what an agent sends with ab_verdict, ab_checks and ab_suggest, checked
// (plugin/shared/shapes.ts), and kept on the reply that ends its turn (the store's session.shape and message.add).
// Run: node test/shapes.ts

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { shapeOf, withDraft } from "../plugin/shared/shapes.ts";
import type { Draft } from "../plugin/shared/types.ts";
import { createStore, publicState, sessionDetail } from "../plugin/shared/store.ts";
import { contextText } from "../plugin/cli/context.ts";
import { renderText } from "../server/show.ts";

let failures = 0;
const check = (cond: unknown, label: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};

// ---------- what it sends, checked ----------
check(JSON.stringify(shapeOf({ verdict: "done", line: "  Checkout p95 is\n310 ms  " }).shape) === '{"verdict":{"kind":"done","line":"Checkout p95 is 310 ms"}}', "a verdict and its line, the line on one line");
check(/verdict must be one of/.test(shapeOf({ verdict: "great", line: "x" }).error) && /line is required/.test(shapeOf({ verdict: "done", line: " " }).error), "a verdict it doesn't know, or without a line, is turned away");
const c = shapeOf({ checks: [{ status: "failed", label: "Lint", detail: "2 errors, both on main too" }, { status: "not_checked", label: "Production data", detail: "" }, { status: "passed", label: "43 tests" }] }).shape;
check(c.checks.length === 3 && c.checks[0].detail === "2 errors, both on main too" && !("detail" in c.checks[1]) && c.checks[2].status === "passed", "checks: each its status, label and detail, an empty detail left out, and one that passed kept from an older plugin");
check(/status must be one of failed, not_checked/.test(shapeOf({ checks: [{ status: "ok", label: "x" }] }).error) && /needs a label/.test(shapeOf({ checks: [{ status: "not_checked" }] }).error) && /list/.test(shapeOf({ checks: [] }).error), "a check without a status it knows, or a label, or none at all, is turned away");
check(shapeOf({ checks: Array.from({ length: 20 }, (_, i) => ({ status: "not_checked", label: `t${i}` })) }).shape.checks.length === 12, "twelve checks at most");
check(JSON.stringify(shapeOf({ replies: ["Open the PR", " Open the PR ", "", "Not now", "a", "b", "c", "d", "e"] }).shape.replies) === '["Open the PR","Not now","a","b","c","d"]', "replies: trimmed, once each, six at most");
check(/at least one/.test(shapeOf({ replies: [" "] }).error) && /Nothing to show/.test(shapeOf({}).error), "no replies, or nothing at all, is turned away");
check("x".repeat(500).slice(0, 200) === shapeOf({ verdict: "found", line: "x".repeat(500) }).shape.verdict.line, "a long line is cut");

// ---------- what it made or found: drafts, cards, slots, its path, what matters ----------
const g = shapeOf({ verdict: "found", line: "x", gist: ["one", " two ", "", "three", "four"] }).shape.verdict;
check(JSON.stringify(g.gist) === '["one","two","three"]', "a verdict's gist: three short lines at most");
const doable = shapeOf({ checks: [{ status: "not_checked", label: "Real iOS Safari", detail: "headless Chrome only", do: " Check it on real iOS Safari " }, { status: "failed", label: "Lint" }] }).shape.checks;
check(doable[0].do === "Check it on real iOS Safari" && !("do" in doable[1]), "a check's do: what to send to have it checked, kept only when given");
const mail = shapeOf({ draft: { kind: "email", to: "a@acme.dev, b@acme.dev", subject: "Raise our limit", body: "Hi,\n\n\n\nCould you   raise it?  \nThanks" } }).shape.drafts[0];
check(mail.kind === "email" && Array.isArray(mail.to) && mail.to.join() === "a@acme.dev,b@acme.dev" && mail.body === "Hi,\n\nCould you   raise it?\nThanks" && mail.cc.length === 0, "an email: who it's to (a list, or one string), its subject, its body with its lines kept");
check(/who it's to/.test(shapeOf({ draft: { kind: "email", subject: "x", body: "y" } }).error) && /subject/.test(shapeOf({ draft: { kind: "email", to: "a@b.c", body: "y" } }).error) && /kind must be one of email, pull_request, invite, message/.test(shapeOf({ draft: { kind: "fax" } }).error), "an email without who it's to or a subject, or a kind it doesn't know, is turned away");
const pr = shapeOf({ draft: { kind: "pull_request", title: "Batch the lookup", body: "Why", branch: "fix-tax", base: "main" } }).shape.drafts[0];
check(pr.title === "Batch the lookup" && pr.branch === "fix-tax" && pr.base === "main", "a pull request: its title, description, branch and base");
const inv = shapeOf({ draft: { kind: "invite", title: "Ledger review", when: "2026-10-30T15:00", minutes: "30", attendees: ["lena@acme.dev"] } }).shape.drafts[0];
check(inv.when === "2026-10-30T15:00" && inv.minutes === 30 && inv.attendees[0] === "lena@acme.dev" && /when it is/.test(shapeOf({ draft: { kind: "invite", title: "x", when: "someday" } }).error), "an invite: when (a time it can read), how long, who");
check(shapeOf({ draft: { kind: "message", to: "#releases", via: "Slack", body: "0.4 is out" } }).shape.drafts[0].via === "Slack" && /who or where/.test(shapeOf({ draft: { kind: "message", body: "x" } }).error), "a message: where it goes and through what");
const d1: Draft = { kind: "email", action: null, body: "", subject: "A" };
check(withDraft([d1, { kind: "pull_request", action: null, body: "", title: "B" }], { kind: "email", action: null, subject: "A", body: "new" }).map((d) => d.body || d.title).join() === "B,new" && withDraft([{ kind: "email", action: null, body: "", subject: "1" }, { kind: "email", action: null, body: "", subject: "2" }, { kind: "email", action: null, body: "", subject: "3" }], { kind: "email", action: null, body: "", subject: "4" }).map((d) => d.subject).join() === "2,3,4", "a draft joins the turn's others: one with the same subject replaces it, three at most");
const cards = shapeOf({ cards: [{ title: "Tasca do Chico", image: "https://x.test/a.jpg", facts: ["★ 4.6", "€€", "6 min walk", "a", "b", "c"], badge: "Takes 4 at 20:30", actions: ["Book 20:30", { label: "Map", says: "Send me the map" }, "c", "d"] }, { title: "TAP to Tokyo", price: { value: "812", unit: "€", limit: 800, series: [842, "830", "x", 812], from: "Sep 22", to: "today" } }] }).shape.cards;
check(cards[0].image === "https://x.test/a.jpg" && cards[0].facts.length === 5 && cards[0].actions.length === 3 && cards[0].actions[1].says === "Send me the map", "a card: its picture, five facts at most, a badge, three buttons at most, each saying what it sends");
check(cards[1].price.value === 812 && cards[1].price.limit === 800 && cards[1].price.series.join() === "842,830,812", "a price: a number, its limit, its history (what isn't a number left out)");
check(shapeOf({ cards: [{ title: "x", price: { value: 95, unit: "USD/night" } }] }).shape.cards[0].price.unit === "USD/night", "a price's unit can say what it's per: USD/night isn't cut to USD/nigh");
check(shapeOf({ cards: [{ title: "x" }] }).shape.cardsPick === "several" && shapeOf({ cards: [{ title: "x" }], pick: "one" }).shape.cardsPick === "one" && /pick must be one of several, one/.test(shapeOf({ cards: [{ title: "x" }], pick: "two" }).error), "cards are picked several at a time unless it says one, and a pick it doesn't know is turned away");
check(!shapeOf({ cards: [{ title: "x", image: "http://plain.test/a.jpg" }] }).shape.cards[0].image && /needs a title/.test(shapeOf({ cards: [{ text: "x" }] }).error), "a picture only over https; a card without a title is turned away");
const sl = shapeOf({ slots: { title: "Ledger review", minutes: 30, times: [{ at: "2026-10-27T10:00", best: true }, "2026-10-28T11:00"] } }).shape.slots;
check(sl.times.length === 2 && sl.times[0].best && !sl.times[1].best && sl.minutes === 30 && /each time/.test(shapeOf({ slots: { title: "x", times: [{ at: "soon" }] } }).error), "slots: times it can read, its picks marked");
const taken = shapeOf({ stages: [{ text: "Read it", minutes: 4 }, { text: "Cached the rates", minutes: 8, dead: "stale at month end" }, { text: "Batched it" }] }).shape.path;
check(taken.stages.length === 3 && taken.stages[1].dead === "stale at month end" && !("minutes" in taken.stages[2]), "its path: stages, a dead end with why, minutes when it said");
const marks = shapeOf({ items: [{ text: "the export retried every 429", note: "the cause" }, "I haven't tried it against the real ERP"] }).shape;
check(marks.marks.length === 2 && marks.marks[0].note === "the cause" && !marks.excerpts, "without a source, what matters is marked in its reply");
const ex = shapeOf({ source: "/docs/renewal.pdf", items: [{ text: "This Agreement shall renew for twenty-four (24) months unless…", mark: "twenty-four (24) months", where: "p. 4, §7.2", label: "Changed", note: "It was 12 months" }, { text: "Fees at USD 0.004", mark: "not in it" }] }).shape.excerpts;
check(ex.title === "renewal.pdf" && ex.items[0].mark === "twenty-four (24) months" && ex.items[0].where === "p. 4, §7.2" && !ex.items[1].mark, "with a source, its passages: what to mark only when the passage has it, where, a note");

// ---------- kept on the reply that ends the turn ----------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-shapes-"));
const store = createStore({ file: path.join(dir, "agentbook.db"), filesDir: path.join(dir, "files"), outbox: false, legacy: false });
store.commit({ t: "session.hello", proc: "box-1", agent: "claude", agent_name: "Claude", kind: "claude-code", label: "wren", session_id: "s1", cwd: dir, root: dir });
const msgs = () => store.state.messages.filter((m) => m.post === "s1");
const last = () => msgs().at(-1);

store.commit({ t: "session.status", post: "s1", state: "working", turn: "start" });
store.commit({ t: "session.shape", post: "s1", shape: { verdict: { kind: "partly", line: "Half" } } });
store.commit({ t: "session.shape", post: "s1", shape: { verdict: { kind: "done", line: "All of it" }, checks: [{ status: "passed", label: "12 tests" }] } });
store.commit({ t: "session.shape", post: "s1", shape: { replies: ["Open the PR"] } });
check(!msgs().some((m) => m.shape), "it waits: on no message yet");
store.commit({ t: "message.add", post: "s1", from: "agent", via: "dash", text: "", file_id: "f1" });
store.commit({ t: "message.add", post: "s1", from: "agent", via: "dash", text: "/context printed this", command: "context" });
check(!msgs().some((m) => m.shape), "a file it sent, or what a slash command printed, isn't its reply");
store.commit({ t: "message.add", post: "s1", from: "agent", via: "terminal", text: "Done for now." });
check(last().shape?.verdict?.line === "All of it" && last().shape.checks[0].label === "12 tests" && last().shape.replies[0] === "Open the PR", "the reply that ends the turn takes it all, each part as last said");
store.commit({ t: "message.add", post: "s1", from: "agent", via: "dash", text: "And one more thing." });
check(!last().shape && !store.state.sessions.s1.shape, "once: the next message doesn't take it again");

store.commit({ t: "session.shape", post: "s1", shape: { verdict: { kind: "blocked", line: "No access" } } });
store.commit({ t: "message.add", post: "s1", from: "human", via: "dash", text: "Try again" });
check(!last().shape && store.state.sessions.s1.shape, "a message of yours doesn't take it");
store.commit({ t: "session.status", post: "s1", state: "working", turn: "start" });
store.commit({ t: "message.add", post: "s1", from: "agent", via: "terminal", text: "Trying again." });
check(!last().shape, "a turn's that no reply took is gone when the next turn starts");
store.commit({ t: "session.shape", post: "s1", shape: shapeOf({ cards: [{ title: "Plan A" }, { title: "Plan B" }], pick: "one" }).shape });
store.commit({ t: "session.shape", post: "s1", shape: shapeOf({ cards: [{ title: "Set up 1" }, { title: "Set up 2" }] }).shape });
store.commit({ t: "message.add", post: "s1", from: "agent", via: "terminal", text: "Pick the ones you want." });
check(last().shape?.cards?.[0].title === "Set up 1" && last().shape.cardsPick === "several", "cards sent again take their own pick, not the last ones' (one)");

// ---------- a turn that ends asking for you ----------
const how = () => publicState(store.state).sessions.find((s) => s.id === "s1");
const turn = (kind, line, text) => {
  store.commit({ t: "session.status", post: "s1", state: "working", turn: "start" });
  store.commit({ t: "session.shape", post: "s1", shape: { verdict: { kind, line } } });
  store.commit({ t: "message.add", post: "s1", from: "agent", via: "terminal", text });
};
store.commit({ t: "session.status", post: "s1", state: "idle", turn: "end" });
check(how().effective === "idle" && !how().asking, "a turn that ended on cards, with no verdict, leaves it idle");
turn("blocked", "Ramp is signed out in Browser 1", "Sign in, then tell me.");
check(how().effective === "working", "while that turn goes on, it's working");
store.commit({ t: "session.status", post: "s1", state: "idle", turn: "end" });
check(how().effective === "needs" && how().asking?.kind === "blocked" && how().asking.line === "Ramp is signed out in Browser 1" && sessionDetail(store.state, "s1").asking?.kind === "blocked", "a turn that ended blocked needs you, saying why, in the feed and on its page");
store.commit({ t: "session.sleep", post: "s1", reason: "idle" });
check(how().effective === "needs", "asleep, it still needs you, as with a question");
// ab_show, from the feed as the server hands it over (renderView).
const shown = () => {
  const v = publicState(store.state);
  return renderText({ ...v, sessions: Object.fromEntries(v.sessions.map((s) => [s.id, s])), agents: Object.fromEntries(v.agents.map((a) => [a.id, a])) }, null, (s) => s.going || null);
};
const label = how().label;
check(new RegExp(`Waiting on the person \\(1\\)\\n  thread   blocked    ${label}\\s+Ramp is signed out in Browser 1`).test(shown()), "ab_show lists it as waiting on the person, with its verdict's line");
check(new RegExp(`\\n  ${label}\\s+needs `).test(shown()) && /ended its turn blocked: Ramp is signed out in Browser 1/.test(shown()), "and its row says needs, and why, as the page does");
store.commit({ t: "message.add", post: "s1", from: "human", via: "dash", text: "Signed in, go on" });
check(how().effective !== "needs" && !how().asking, "once you write to it, it doesn't");
check(/Waiting on the person \(0\)\n  nothing/.test(shown()), "and ab_show stops listing it");
turn("needs_you", "Land it on main?", "Want me to land it?");
store.commit({ t: "session.status", post: "s1", state: "idle", turn: "end" });
check(how().effective === "needs" && how().asking?.kind === "needs_you", "and so does one that ended saying it needs you");
store.commit({ t: "message.add", post: "s1", from: "agent", via: "dash", text: "Also: the tests passed." });
check(how().effective !== "needs" && !how().asking, "something said after that reply means the reply isn't what it ended on");
turn("done", "Shipped", "Done.");
store.commit({ t: "question.ask", post: "s1", qid: "q1", title: "Land it?" });
store.commit({ t: "session.status", post: "s1", state: "idle", turn: "end" });
check(how().effective === "needs" && !how().asking, "a question it left open needs you as it did, the bell listing the question rather than the thread");
store.commit({ t: "question.answer", qid: "q1", value: "Yes" });
turn("blocked", "No access", "Can't get in.");
store.commit({ t: "session.status", post: "s1", state: "idle", turn: "end" });
store.commit({ t: "session.flag", post: "s1", archived: true });
check(how().effective !== "needs" && !how().asking, "archived, it doesn't need you any more");

// ---------- Visual mode, in what a session is told ----------
const on = contextText({ kind: "claude-code", agent: "Claude", person: "herval" });
const off = contextText({ kind: "claude-code", agent: "Claude", person: "herval", visual: false });
check(/Visual mode is on: herval reads your reply/.test(on) && /answer in the first sentence/.test(on) && /Under 120 words/.test(on) && /ab_verdict/.test(on) && /ab_suggest/.test(on) && /only when text can't do the job/.test(on) && /ab_compare/.test(on), "Visual mode: the session is told how to write the reply that ends a turn (the answer first, dense, under 120 words), the two tools that go with it, and that the rest are by exception");
check(/Visual mode is on/.test(off), "for every agent: there's no turning it off");
store.commit({ t: "agent.hello", agent: "claude", agent_name: "Claude", kind: "claude-code" });
store.commit({ t: "agent.visual", agent: "claude", visual: false });
check(store.state.agents.claude && !("visual" in store.state.agents.claude), "an old switch's op (from when it had one) leaves nothing on the agent");

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : "\nAll passed");
process.exit(failures ? 1 : 0);
