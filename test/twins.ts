#!/usr/bin/env node
// An agent that lives on another machine keeps one id whichever machine reaches it (server/relay.ts): hervalm5
// reaches brick's OpenClaw gateway, then brick's own agentbook-cli reports the same agent and threads. Checked on
// the relay itself: they share the page's ids, what you set there carries over, the machine it lives on has it
// while that's on (else hervalm5 does), a restart keeps all of it, the same agent id on another gateway stays
// apart, and a machine that only says where its agent lives later still gets the shared id. Only one person's
// machines share: another person's machine saying the same (its gateway named "brick" too, with "main" on it, or a
// lie) gets ids of its own, never takes yours over, and what it sets on its own stays on its own.
// Run: node test/twins.ts

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRelay } from "../server/relay.ts";
import { closeSql, sql } from "./harness-sql.ts";

let failures = 0;
const check = (cond: unknown, label: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-twins-"));
const people = { u1: { id: "u1", username: "herval" }, u2: { id: "u2", username: "mallory" } };
const accounts = { byId: (id) => people[id] || null, deviceById: () => null };
let relay = createRelay({ home: HOME, accounts });

// A machine's ops, numbered as its CLI numbers them.
const seqs = new Map();
const send = (D, ops, info = null) => {
  const out = ops.map(([kind, args]) => {
    seqs.set(D.id, (seqs.get(D.id) || 0) + 1);
    return { kind, seq: seqs.get(D.id), at: new Date().toISOString(), args };
  });
  return relay.ingest(D, { ops: out, info });
};
const on = (D) => Object.assign(D, { seen: Date.now(), polled: Date.now(), polls: 1 });
const off = (D) => Object.assign(D, { seen: 0, polled: 0, polls: 0 });
const AGENT = "openclaw-moneynuggs";
const KEY = "agent:moneynuggs:telegram:direct:1";
const hello = (extra = {}) => ["agent.hello", { agent: AGENT, agent_name: "Moneynuggs", kind: "openclaw", ...extra }];
const thread = ["post.hello", { proc: `openclaw:${KEY}`, session_id: KEY, agent: AGENT, kind: "openclaw", label: "kite", channel: true }];
const shows = (D) => {
  const v = relay.view(D);
  return { agent: v.agents.some((a) => a.id === AGENT), thread: v.sessions.some((s) => s.id === KEY) };
};

try {
  // hervalm5 reaches brick's gateway, with a CLI from before agents said where they run: its info says so.
  const H = on(relay.device("dH", { name: "hervalm5", user_id: "u1" }));
  send(H, [hello(), thread, ["post.hello", { proc: "claude-1", session_id: "s-claude", agent: "claude", label: "wren" }]], { [`agent:${AGENT}`]: { host: "brick" } });
  check(relay.idOf(H, AGENT) === AGENT && relay.idOf(H, KEY) === KEY, "hervalm5 names brick's agent and its thread, as before");
  // What you set on them there.
  H.store.commit({ t: "session.flag", post: KEY, archived: true });
  H.store.commit({ t: "agent.visibility", agent: AGENT, visibility: "public" });
  H.store.commit({ t: "agent.profile", agent: AGENT, bio: "I keep an eye on things.", avatar: { emoji: "🦉" } });
  H.store.commit({ t: "agent.rename", agent: AGENT, name: "Nuggets" });
  send(H, [hello()]);
  check(H.store.state.agents[AGENT]?.name === "Nuggets" && H.store.state.agents[AGENT]?.glyph === "N", "the name you gave it stays when its gateway says its own again");

  // brick's own agentbook-cli connects, and reports the same agent and thread, saying where it runs.
  const B = off(relay.device("dB", { name: "brick", user_id: "u1" }));
  send(B, [hello({ host: "brick" }), thread]);
  check(relay.idOf(B, AGENT) === AGENT && relay.idOf(B, KEY) === KEY, "brick's own report is the same agent and thread, by the same ids");
  check(B.store.state.sessions[KEY]?.archived === true && B.store.state.agents[AGENT]?.visibility === "public", "what you set there (archived, public) carries over to brick's");
  check(B.store.state.agents[AGENT]?.bio === "I keep an eye on things." && B.store.state.agents[AGENT]?.avatar?.emoji === "🦉", "its bio and custom picture carry over when another machine reports the same agent");
  send(B, [hello({ host: "brick" })]);
  check(B.store.state.agents[AGENT]?.name === "Nuggets", "and so does its name, which brick's own hello doesn't undo");
  check(relay.idOf(H, "claude") === "claude" && relay.twins(H, "s-claude").length === 1, "what lives on hervalm5 itself isn't shared");

  check(relay.resolve(AGENT)?.D === H && relay.resolve(KEY)?.D === H, "while brick is off, hervalm5 has it");
  check(shows(H).agent && shows(H).thread && !shows(B).agent && !shows(B).thread, "and only hervalm5's shows: once, not twice");

  // brick on: it has it, where it lives.
  on(B);
  check(relay.resolve(AGENT)?.D === B && relay.resolve(KEY)?.D === B, "brick on: brick has it");
  check(!shows(H).agent && !shows(H).thread && shows(B).agent && shows(B).thread, "and only brick's shows");
  check(relay.shadowed(H, AGENT) && !relay.shadowed(B, AGENT), "hervalm5's is brick's to show");
  check(relay.twins(H, KEY).map((t) => t.D.name).join(",") === "hervalm5,brick", "both machines have the thread (what you set goes to both)");

  off(B);
  check(relay.resolve(AGENT)?.D === H, "brick off again: hervalm5 has it again");

  // Another gateway with an agent of the same id ("main" is every gateway's first): apart.
  const M = on(relay.device("dM", { name: "mini", user_id: "u1" }));
  send(M, [hello({ host: "studio" })]);
  check(relay.idOf(M, AGENT) === `mini~${AGENT}` && relay.twins(M, AGENT).length === 1, "the same agent id on another gateway is another agent");

  // A laptop's CLI reports brick's agent before saying where it runs, and says so in its info after.
  const L = on(relay.device("dL", { name: "laptop", user_id: "u1" }));
  send(L, [hello()]);
  const early = relay.idOf(L, AGENT);
  for (const t of relay.twins(H, AGENT)) t.D.store.commit({ t: "agent.profile", agent: t.local, bio: "", avatar: null });
  L.store.commit({ t: "agent.profile", agent: AGENT, bio: "Old bio", avatar: { emoji: "🦆" } });
  send(L, [], { [`agent:${AGENT}`]: { host: "brick.tail1234.ts.net" } });
  check(L.store.state.agents[AGENT]?.bio === "" && L.store.state.agents[AGENT]?.avatar === null, "cleared bios and reset pictures carry over too, replacing stale profile values");
  check(early === `laptop~${AGENT}` && relay.idOf(L, AGENT) === AGENT && !relay.resolve(early), "said later, where it lives makes it the shared one (and its own id goes)");

  // Another person's machine says the same: an agent with that id on "brick", and a thread with that key.
  const E = on(relay.device("dE", { name: "evil", user_id: "u2" }));
  send(E, [hello({ host: "brick" }), thread]);
  check(relay.idOf(E, AGENT) === `evil~${AGENT}` && relay.idOf(E, KEY) === `evil~${KEY}`, "another person's machine saying the same gets ids of its own");
  check(relay.twins(B, KEY).every((t) => t.D.user_id === "u1") && relay.twins(E, KEY).length === 1, "and its thread isn't a twin of yours");
  off(H);
  off(B);
  check(relay.resolve(KEY)?.D.user_id === "u1" && relay.resolve(AGENT)?.D.user_id === "u1" && relay.resolve(`evil~${KEY}`)?.D === E, "with yours off and theirs on, your thread's id is still yours, and theirs is theirs");
  // What they set on theirs, the way the page sets it on every machine that has a thread.
  for (const t of relay.twins(E, KEY)) t.D.store.commit({ t: "session.visibility", post: t.local, visibility: "public", show_work: true });
  check(H.store.state.sessions[KEY]?.visibility !== "public" && B.store.state.sessions[KEY]?.visibility !== "public", "making theirs public leaves yours as it was");
  // Their own other machine on that gateway shares their ids, as yours do.
  const E2 = on(relay.device("dE2", { name: "evil2", user_id: "u2" }));
  send(E2, [hello({ host: "brick" }), thread]);
  check(relay.idOf(E2, AGENT) === relay.idOf(E, AGENT) && relay.idOf(E2, KEY) === relay.idOf(E, KEY), "their own other machine shares theirs");

  // A restart keeps all of it.
  for (const D of relay.devices.values()) D.store.close?.();
  relay = createRelay({ home: HOME, accounts });
  const H2 = on(relay.device("dH", { name: "hervalm5", user_id: "u1" }));
  const B2 = on(relay.device("dB", { name: "brick", user_id: "u1" }));
  relay.device("dL", { name: "laptop", user_id: "u1" });
  check(relay.idOf(H2, AGENT) === AGENT && relay.idOf(B2, AGENT) === AGENT && relay.idOf(B2, KEY) === KEY, "after a restart: the same ids");
  check(relay.resolve(KEY)?.D === B2 && relay.shadowed(H2, KEY), "and brick, on, has it");
  const E3 = on(relay.device("dE", { name: "evil", user_id: "u2" }));
  check(relay.idOf(E3, KEY) === `evil~${KEY}` && relay.twins(B2, KEY).every((t) => t.D.user_id === "u1"), "and another person's machine stays apart");

  // A relay.db from before only one person's machines shared: what lives where was kept for everyone at once, with no
  // person, so none of it is folded in; and one machine of another person's shared a thread of yours. That goes, and
  // each machine's store says it again.
  const OLD = path.join(HOME, "before");
  fs.mkdirSync(OLD);
  sql(path.join(OLD, "relay.db")).exec(`create table homes (home text not null, local text not null, global text not null, primary key (home, local));
    insert into homes (home, local, global) values ('brick', '${AGENT}', '${AGENT}');
    create table twins (device text not null, local text not null, global text not null, primary key (device, local));
    insert into twins (device, local, global) values ('dE', '${KEY}', '${KEY}');`);
  closeSql(path.join(OLD, "relay.db"));
  createRelay({ home: OLD, accounts });
  const folded = sql(path.join(OLD, "storage.db"));
  check(!folded.prepare("select 1 from homes").get() && folded.prepare("select count(*) n from twins").get().n === 1, "a relay.db from before folds in without what lived where (it says no person), and with the rest");
  closeSql(path.join(OLD, "storage.db"));
  for (const D of relay.devices.values()) D.store.close?.();
  sql(path.join(HOME, "storage.db")).exec(`delete from homes; delete from ids where device = 'dE' and local = '${KEY}';
    insert into twins (device, local, global) values ('dE', '${KEY}', '${KEY}');`);
  closeSql();
  relay = createRelay({ home: HOME, accounts });
  const H4 = on(relay.device("dH", { name: "hervalm5", user_id: "u1" }));
  on(relay.device("dB", { name: "brick", user_id: "u1" }));
  const E4 = on(relay.device("dE", { name: "evil", user_id: "u2" }));
  const N = on(relay.device("dN", { name: "mini2", user_id: "u1" }));
  send(N, [hello({ host: "brick" })]);
  check(relay.idOf(N, AGENT) === AGENT && relay.twins(H4, AGENT).some((t) => t.D === N), "where it lives is learned again: a new machine of yours shares the agent");
  check(relay.idOf(E4, KEY) === `evil~${KEY}` && !relay.twins(H4, KEY).some((t) => t.D === E4), "and the other person's machine that shared your thread has its own again");
} catch (e) {
  check(false, `test crashed: ${e.stack}`);
} finally {
  for (const D of relay.devices.values()) D.store.close?.();
  fs.rmSync(HOME, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
