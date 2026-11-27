#!/usr/bin/env node
// What the server and the page ask of a runtime (plugin/shared/runtimes.ts), in place of the lists of runtime names
// they kept: each cap gives the runtimes those lists named, so what each runtime can do is as it was. And a thread's
// runtime by its proc and where it runs, older procs ("managed:") included, and a routine's note by its agent's kind.
// Run: node test/runtime-caps.ts

import { capsOf, drivenRuntime, RUNTIMES, runtimeInfo, runtimeOfThread, type RuntimeCaps } from "../plugin/shared/runtimes.ts";
import { agentRoutineNote } from "../plugin/shared/routine-threads.ts";

let failures = 0;
const check = (cond: unknown, label: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const all = Object.values(RUNTIMES);
const which = (has: (c: RuntimeCaps) => unknown) =>
  all
    .filter((r) => has(r.caps))
    .map((r) => r.id)
    .join(",");
// The runtimes an agent can be of: the clouds are where an agent's threads run, not a kind of agent.
const kinds = (has: (c: RuntimeCaps) => unknown) =>
  all
    .filter((r) => r.about && has(r.caps))
    .map((r) => r.id)
    .join(",");

check(kinds((c) => c.writesPages) === "claude-code,codex,openclaw,hermes,dsh,antigravity,grok,claude-agent", "the agents that write pages and notes are the ones that have agentbook's tools, all but Devin (TOOL_KINDS)");
check(kinds((c) => c.tools === "sure") === "claude-code,codex,antigravity,grok,claude-agent", "the ones that surely have agentbook's tools, told to use them plainly (SURE_TOOLS)");
check(kinds((c) => c.guests) === "claude-code,codex,openclaw,hermes", "the ones a thread can bring in as guests (GUEST_KINDS)");
check(kinds((c) => c.groupFolders) === "claude-code,codex", "the ones that work in a group's folder (FOLDER_AGENTS)");
check(kinds((c) => c.routines) === "claude-code,codex,openclaw,hermes,dsh,antigravity,grok", "the ones routines run on, in the order the routine form lists them (ROUTINE_KINDS)");
check(kinds((c) => c.limits) === "claude-code,codex,openclaw" && capsOf("openclaw").limits === "shared" && capsOf("codex").limits === "own", "the ones whose usage limits show, OpenClaw's its gateway's (LIMITS_KINDS)");
check(which((c) => c.resumes) === "claude-code", "only Claude Code's ended sessions are resumed");
check(which((c) => c.updates) === "claude-code,codex,grok", "agentbook updates the apps of Claude Code, Codex and Grok on a machine (runtime.update)");
check(which((c) => c.installs) === "hermes,dsh,antigravity,grok", "a machine installs Hermes, DeepSeek Harness, Antigravity and Grok from the page (runtime.install)");
check(which((c) => c.avatars) === "openclaw", "only OpenClaw gives its agents pictures to go back to (AVATAR_FROM)");
check(kinds((c) => c.side) === "claude-code,codex", "side threads go on from Claude Code and Codex threads");
check(kinds((c) => c.commands && c.models) === "claude-code,codex,grok", "a /model is checked against the models of Claude Code, Codex and Grok");
check(
  all
    .filter((r) => r.procs.length && r.caps.commands)
    .map((r) => r.id)
    .join(",") === "codex,openclaw,grok",
  "the driven threads that take slash commands are Codex's, OpenClaw's and Grok's",
);
check(which((c) => c.applies) === "codex-cloud" && which((c) => !c.replies) === "codex-cloud", "Codex Cloud's tasks apply here, and take replies on their own page");
check(
  all
    .filter((r) => r.setup)
    .map((r) => r.id)
    .join(",") === "claude-agent,devin",
  "Claude Agent and Devin are connected by a key, on Settings → Agents",
);

// The words the page said of each kind of agent, now its runtime's.
const KINDS = { "claude-code": "Coding agent in Claude Code", codex: "Coding agent in Codex", openclaw: "Agent in OpenClaw", hermes: "Agent in Hermes", dsh: "Agent in DeepSeek Harness", antigravity: "Coding agent in Antigravity CLI", grok: "Coding agent in Grok CLI", "claude-agent": "Agent in Anthropic's cloud", devin: "Agent in Devin's cloud" };
const KIND_SHORT = { "claude-code": "Claude Code", codex: "Codex", openclaw: "OpenClaw", hermes: "Hermes", dsh: "DeepSeek Harness", antigravity: "Antigravity", grok: "Grok", "claude-agent": "Claude Agent", devin: "Devin" };
const agents = all.filter((r) => r.about);
check(JSON.stringify(Object.fromEntries(agents.map((r) => [r.id, r.about]))) === JSON.stringify(KINDS), "each kind of agent is what it was, in the same order");
check(JSON.stringify(Object.fromEntries(agents.map((r) => [r.id, r.name]))) === JSON.stringify(KIND_SHORT), "and so is each one's name");
check(RUNTIMES["codex-cloud"].placeWords?.runs === "In Codex Cloud" && RUNTIMES["claude-cloud"].placeWords?.open === "Open on claude.ai", "a cloud thread says where it runs as it did");

check(runtimeOfThread({ proc: "managed:sesn_1" }) === "claude-agent" && runtimeOfThread({ proc: "claude-agent:sesn_1" }) === "claude-agent", "a Claude Agent thread from before it had one name is Claude Agent's");
check(runtimeOfThread({ cloud: "codex", proc: "codexcloud:task_e_1" }) === "codex-cloud" && runtimeOfThread({ cloud: "claude" }) === "claude-cloud", "a thread in a cloud is that cloud's");
check(runtimeOfThread({ proc: "12345" }) === "claude-code" && runtimeOfThread({ proc: "launch:l1" }) === "claude-code" && runtimeOfThread(null) === "claude-code", "a Claude Code session's proc, a start and nothing at all are Claude Code's");
check(drivenRuntime({ proc: "codex:t1" })?.name === "Codex" && drivenRuntime({ proc: "managed:s" })?.name === "Claude Agent" && !drivenRuntime({ proc: "12345" }) && !drivenRuntime({ proc: "codex:t1", cloud: "codex" }), "a driven thread is its runtime's, and neither Claude Code's nor a cloud's is driven");
check(runtimeInfo("no-such-runtime").id === "claude-code" && runtimeInfo(undefined).id === "claude-code", "an agent of a kind this version doesn't know, or of none, is Claude Code's");

check(/a routine on claude\.ai, trigger id r1/.test(agentRoutineNote({ kind: undefined, job: "r1" })) && /RemoteTrigger/.test(agentRoutineNote({ kind: undefined, job: "r1" })), "an agent with no kind is told of a routine on claude.ai");
check(/a Codex automation in the ChatGPT app, id a1/.test(agentRoutineNote({ kind: "codex", job: "a1" })) && /OpenClaw cron job/.test(agentRoutineNote({ kind: "openclaw", job: "c1" })), "Codex's of an automation, OpenClaw's of a cron job");

console.log(failures ? `\n${failures} failed` : "\nAll passed");
process.exit(failures ? 1 : 0);
