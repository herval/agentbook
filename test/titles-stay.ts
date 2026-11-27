#!/usr/bin/env node
// A thread keeps the title it was found by. Its agent's first headline (ab_post) titles it, and a later one changes
// only its text, unless the person asked for a new title (rename). Its runtime's own title (Claude Code's
// ai-title, which it rewrites as the conversation goes on) is the first one it gave, a copy folded into it too.
// Run: node test/titles-stay.ts

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../plugin/shared/store.ts";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-titles-stay-"));
let failures = 0;
const check = (cond: unknown, label: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};

try {
  const file = path.join(HOME, "store", "agentbook.db");
  const filesDir = path.join(HOME, "store", "files");
  let store = createStore({ file, filesDir, legacy: false });
  const hello = (sid: string, pid: number) => store.ingest({ t: "session.hello", proc: `box-${pid}`, session_id: sid, agent: "claude", agent_name: "Claude", kind: "claude-code", label: "kite", cwd: HOME, transcript: `/t/${sid}.jsonl` });
  const A = "0a1b2c3d-0000-4000-8000-0000000000a1";
  hello(A, 1);

  store.ingest({ t: "session.post", post: A, title: "Split LaunchDarkly out of the global stack", text: "Its own stack, so a flag change doesn't plan everything." });
  check(store.state.sessions[A].title === "Split LaunchDarkly out of the global stack", "its agent's first headline titles the thread");
  store.ingest({ t: "session.post", post: A, title: "Fix failing checks on the stack split", text: "Two checks failed after the split." });
  check(store.state.sessions[A].title === "Split LaunchDarkly out of the global stack" && store.state.sessions[A].text === "Two checks failed after the split.", "a later headline keeps the title and changes the text");
  store.ingest({ t: "session.post", post: A, title: "LaunchDarkly stack split", rename: true });
  check(store.state.sessions[A].title === "LaunchDarkly stack split" && store.state.sessions[A].text === "Two checks failed after the split.", "renamed, as the person asked, it changes");

  store.ingest({ t: "session.snapshot", post: A, ai_title: "LaunchDarkly stack split", model: "claude-opus-5-5" });
  store.ingest({ t: "session.snapshot", post: A, ai_title: "fix pulumi checks", model: "claude-sonnet-5-5" });
  check(store.state.sessions[A].ai_title === "LaunchDarkly stack split" && store.state.sessions[A].model === "claude-sonnet-5-5", "its runtime's title is the first one it gave; the rest of a snapshot still comes in");
  store.ingest({ t: "session.snapshot", post: A, ai_title: null });
  check(store.state.sessions[A].ai_title === "LaunchDarkly stack split", "and a snapshot with none doesn't take it away");

  // A copy Claude Code started on a resume, folded in (session.fold, follow): it brings its session, not its title.
  const COPY = "c0c0c0c0-1111-4000-8000-0000000000c1";
  hello(COPY, 2);
  store.ingest({ t: "session.snapshot", post: COPY, ai_title: "resume pulumi work" });
  store.ingest({ t: "session.fold", post: A, copy: COPY.slice(0, 8), follow: true });
  check(store.state.sessions[A].session_id === COPY && store.state.sessions[A].ai_title === "LaunchDarkly stack split", "a copy folded in goes on in its session, under the thread's title");

  // A thread with no title of its runtime's yet takes the first it gives.
  const B = "bbbb0000-0000-4000-8000-0000000000b1";
  hello(B, 3);
  store.ingest({ t: "session.snapshot", post: B, ai_title: "Tidy the README" });
  check(store.state.sessions[B].ai_title === "Tidy the README" && !store.state.sessions[B].title, "a thread without one takes the first title its runtime gives");

  store.close();
  store = createStore({ file, filesDir, legacy: false });
  check(store.state.sessions[A].title === "LaunchDarkly stack split" && store.state.sessions[A].ai_title === "LaunchDarkly stack split", "after a restart, the same");
  store.close();
} catch (e) {
  failures++;
  console.log(`FAIL  ${e.stack || e}`);
} finally {
  fs.rmSync(HOME, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
