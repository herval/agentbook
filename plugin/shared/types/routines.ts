// Routines, versions, passkey approvals, runs, and routine threads. Types only, which Node strips: nothing here runs.

import type { By, Iso } from "./common.ts";
import type { PageChange } from "./pages.ts";

// What runs on a schedule (routines.ts): code agentbook runs with no model, or a prompt an agent runs.
export interface Routine {
  id: string;
  kind: "code" | "agent";
  owner?: string | null;
  // The page a code routine keeps widgets on, and the thread an agent routine's runs continue (null: a new one each).
  page: string | null;
  thread?: string | null;
  links?: RoutineLink[];
  name: string;
  about: string;
  // What it can't keep up, in words.
  cant_keep: string;
  schedule: RoutineSchedule;
  on: boolean;
  // The ids of the widgets it writes.
  keeps: string[];
  timeout: number;
  // The version that runs (the newest one OK'd), and the newest.
  live_v: number;
  code_v: number;
  ok_at?: Iso;
  agent: string | null;
  by: By | null;
  created: Iso;
  updated: Iso;
  // Failed runs in a row, since when.
  fails: number;
  failing_since?: Iso | null;
  last: RoutineLast | null;
  last_ok: Iso | null;
  // What its code keeps between runs, as its code wrote it.
  memo: Record<string, unknown>;
  // The agent last asked to fix it, and the launch that went out.
  fix?: { lid: string; agent: string | null; at: Iso };
  archived?: { at: Iso; by: By | null };
}
export interface RoutineLink {
  kind: "agent" | "page" | "thread";
  id: string;
}
// When a routine runs: every so often, on a cron, once, only when it's run, or live while its page is open.
export interface RoutineSchedule {
  kind: "every" | "cron" | "at" | "manual" | "live";
  everyMs?: number;
  expr?: string;
  at?: Iso;
}
// Its last run, in brief. `skipped`: why it didn't run.
export interface RoutineLast {
  at: Iso;
  ok: boolean;
  ms: number;
  error: string | null;
  // The page version it wrote.
  version: number | null;
  v: number;
  changed: string[];
  why: string;
  lid: string | null;
  post: string | null;
  skipped: string | null;
}
// What a code routine may reach: MCP tools as "server/tool", and commands by name.
export interface RoutineReach {
  tools: string[];
  commands: string[];
}
// One version of a routine: its code and reach, or an agent routine's prompt, agent, folder and model; its test run;
// and its owner's OK.
export interface RoutineCode {
  id: string;
  routine: string;
  v: number;
  at: Iso;
  by: By | null;
  summary: string;
  code?: string;
  reach?: RoutineReach;
  prompt?: string;
  agent?: string | null;
  root?: string | null;
  model?: string | null;
  test: RoutineTest | null;
  ok: RoutineOk | null;
  // Passed over: its owner kept the one that runs, or a newer version came.
  passed: "kept" | "newer" | null;
}
// A test run of a version, as a version keeps it (without the widgets' data).
export interface RoutineTest {
  at: Iso;
  ok: boolean;
  ms: number;
  error: string | null;
  summary?: string | null;
  ask?: string | null;
  changes: PageChange[];
}
// Its owner's OK of a version, and their passkey's signature of it, which its runs carry.
export interface RoutineOk {
  at: Iso;
  by: By | null;
  signed?: SignedRoutineOk;
}
export interface SignedRoutineOk {
  envelope: RoutineOkEnvelope;
  sig: PasskeySignature;
}
// What a passkey signs to OK a routine's version (signed.ts).
export interface RoutineOkEnvelope {
  v: 1;
  kind: "routine.ok";
  rid: string;
  version: number;
  name: string;
  use: boolean;
  hash: string;
  root?: string;
  pages?: { id: string; title: string }[];
}
// A passkey's assertion, base64url: which key, and what it signed.
export interface PasskeySignature {
  key: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
}
// One run of a routine: a code run's, or an agent run's (the launch it started, or the thread it wrote to).
export interface RoutineRun {
  id: string;
  routine: string;
  page: string | null;
  at: Iso;
  ms: number;
  ok: boolean;
  why: string;
  v: number;
  error?: string | null;
  // Why it didn't run.
  skipped?: string;
  lid?: string | null;
  post?: string | null;
  log?: string;
  // The widgets it changed, and the page version it wrote.
  changed?: string[];
  version?: number | null;
  ask?: string | null;
  notable?: string | null;
}
// A thread started on a routine from its page.
export interface RoutineThread {
  lid: string;
  agent: string | null;
  at: Iso;
  user?: string;
}
