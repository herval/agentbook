import { agentDirectory } from "../../agent-context.ts";
// What DeepSeek Harness (dsh) keeps on disk, read-only: each session's log
// ($DSH_HOME/sessions/--<folder>--/<id>/session.vN.jsonl.zstd), folded into a thread's steps the same way whether it's
// read from the log or comes as it's written (dsh's plugin), and the models its config options and its own apps' picks
// say.

import { textOf } from "../../../shared/text.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { SEEN_TOOL } from "../../transcript.ts";
import { addSay, addTool, blank, iso, short, toolDone } from "../kit/steps.ts";
import type { DriverDigest } from "../kit/steps.ts";
import type { Models } from "../runtime.ts";

export const HOME_DIR = () => agentDirectory("dsh");

export const readdir = (dir: string) => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};

/* ---------- dsh's session logs ---------- */

// A log is Zstandard frames one after another (one per batch dsh appended), or plain lines. A frame cut short (dsh
// writing it now) ends the read.
const MAGIC = 0xfd2fb528;
function framesOf(buf: Buffer) {
  const out: Buffer[] = [];
  let o = 0;
  while (o + 5 <= buf.length && buf.readUInt32LE(o) === MAGIC) {
    const start = o;
    const d = buf[o + 4];
    o += 5;
    const fcs = d >>> 6;
    const single = (d & 0x20) !== 0;
    const dict = d & 3;
    o += (single ? 0 : 1) + (dict === 3 ? 4 : dict) + (fcs === 0 ? (single ? 1 : 0) : 1 << fcs);
    for (;;) {
      if (o + 3 > buf.length) return out;
      const h = buf.readUIntLE(o, 3);
      o += 3 + (((h >>> 1) & 3) === 1 ? 1 : h >>> 3);
      if (o > buf.length) return out;
      if (h & 1) break;
    }
    if (d & 4) o += 4;
    if (o > buf.length) return out;
    out.push(buf.subarray(start, o));
  }
  return out;
}
// A session's log: the newest format's file in its folder, wherever dsh put that folder.
function logFile(id: string) {
  const root = path.join(HOME_DIR(), "sessions");
  for (const dir of readdir(root))
    for (const name of [id, `session-${id}`]) {
      const files = readdir(path.join(root, dir, name)).filter((f) => /^session(\.v\d+)?\.jsonl(\.zstd)?$/.test(f));
      const v = (f: string) => Number(/\.v(\d+)\./.exec(f)?.[1] || 0);
      if (files.length) return path.join(root, dir, name, files.sort((a, b) => v(a) - v(b)).at(-1));
    }
  return null;
}
export function readLog(id: string) {
  const file = logFile(id);
  if (!file) return null;
  const buf = fs.readFileSync(file);
  const text = file.endsWith(".zstd") ? (zlib.zstdDecompressSync ? framesOf(buf).map((f) => zlib.zstdDecompressSync(f).toString()).join("\n") : null) : buf.toString();
  if (text == null) return null;
  const events = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {}
  }
  return events;
}

// agentbook's own tools show on the thread anyway (its headline, its results), so they aren't steps, as in Claude's,
// but for going through other threads, which you should see.
export const quiet = (name: unknown) => /^mcp__agentbook__/.test(String(name || "")) && !SEEN_TOOL.test(String(name));
const contextOf = (u) => (u ? (u.inputTokens || 0) + (u.cacheReadTokens || 0) + (u.cacheWriteTokens || 0) : 0);

// A thread's digest (blank's), with what's read of its session's log: the last record folded (`seq`), when its turn
// began (`turnAt`, in dsh's ms) and a subagent's label.
export interface DshDigest extends DriverDigest {
  seq?: number;
  turnAt?: number | null;
  label?: string;
}

// One record of a session's log on its thread's digest: a turn begun or ended, what it said, the tools it called and
// how they went, its title, model and how much context it used. The same whether it's read from the log or comes as
// it's written (dsh's plugin). `seq`: the last record folded.
export function foldEvent(d: DshDigest, e, cwd?: string | null) {
  const at = iso(e.time) || new Date().toISOString();
  const x = e.data || {};
  if (Number.isFinite(e.seq)) d.seq = Math.max(d.seq || 0, e.seq);
  switch (e.type) {
    case "turn/start":
      d.turn = Math.max(d.turn + 1, Number(x.turn) || 0);
      d.turnAt = e.time;
      break;
    case "turn/end":
      if (d.turnAt != null && e.time >= d.turnAt) d.worked += e.time - d.turnAt;
      d.turnAt = null;
      break;
    case "assistant/message": {
      const blocks = x.message?.content || [];
      blocks.forEach((b, i) => b?.type === "text" && addSay(d, { id: `${x.message?.id || e.seq}-${i}`, at, text: b.text }));
      if (x.usage) d.context = contextOf(x.usage);
      if (x.message?.source?.model) d.model = x.message.source.model;
      break;
    }
    case "tool/call":
      if (!quiet(x.name)) addTool(d, { id: x.callId, at, name: x.name, args: x.arguments, cwd });
      break;
    case "tool/result": {
      const out = textOf(x.message?.content).trim();
      toolDone(d, x.message?.toolCallId, { at, error: x.message?.isError ? out || "Failed" : null, output: out });
      break;
    }
    case "session/title":
      if (x.title) d.ai_title = short(x.title, 120);
      break;
    case "subagent/descriptor":
      if (x.label) d.label = short(x.label, 120);
      break;
    case "request/header":
      if (x.header?.config?.model) d.model = x.header.config.model;
      break;
  }
  return d;
}
// A thread's steps from its session's log.
export function digestOf(events, cwd?: string | null) {
  const d: DshDigest = blank();
  d.whole = true;
  for (const e of events) foldEvent(d, e, cwd);
  return d;
}

/* ---------- models ---------- */

// dsh's model option values are [provider, model] as JSON; agentbook's model ids are "provider/model".
const pairOf = (v) => {
  try {
    const a = JSON.parse(v);
    return Array.isArray(a) && a.length === 2 && a.every((s) => typeof s === "string" && s) ? a : null;
  } catch {
    return null;
  }
};
// What dsh's config options say: the models to pick from, as agentbook's pickers list them, and the reasoning efforts
// it takes (dsh lists those of its current model; another that takes none says so when it's picked).
export function modelsOf(options): Models | null {
  const m = (options || []).find((o) => o.id === "model");
  if (!m) return null;
  const effort = options.find((o) => o.id === "reasoning_effort");
  const efforts = (effort?.options || []).map((o) => o.value).filter(Boolean);
  const flat = (m.options || []).flatMap((g) => (Array.isArray(g.options) ? g.options : [g]));
  const list = [];
  for (const o of flat) {
    const p = pairOf(o.value);
    if (p && !list.some((x) => x.id === p.join("/"))) list.push({ id: p.join("/"), name: o.name || p[1], efforts, effort: effort?.currentValue || null });
  }
  const current = pairOf(m.currentValue)?.join("/") || list[0]?.id || null;
  return list.length ? { list, default: current, efforts, effort: effort?.currentValue || null } : null;
}
// The model you picked in dsh's own apps (their Models page writes it to that profile's patch layer,
// $DSH_HOME/profiles/<profile>/cordis.patch.yml), the most recent one: what agentbook's sessions start on, since dsh's
// ACP profile starts on its built-in route (one you may have no key for). None when you gave the ACP profile one.
export function defaultModel(home = HOME_DIR()) {
  const of = (profile: string) => {
    const file = path.join(home, "profiles", profile, "cordis.patch.yml");
    try {
      const text = fs.readFileSync(file, "utf8");
      const block = /^-\s*id:\s*["']?agent-default-model\b["']?\s*$([\s\S]*?)(?=^-\s|(?![\s\S]))/m.exec(text)?.[1] || "";
      const field = (k: string) => new RegExp(`^\\s+${k}:\\s*["']?([\\w.:@/-]+)`, "m").exec(block)?.[1] || null;
      return field("provider") && field("model") ? { id: `${field("provider")}/${field("model")}`, effort: field("reasoningEffort"), at: fs.statSync(file).mtimeMs } : null;
    } catch {
      return null;
    }
  };
  if (of("acp")) return null;
  return readdir(path.join(home, "profiles")).filter((p) => p !== "acp").map(of).filter(Boolean).sort((a, b) => b.at - a.at)[0] || null;
}
// A "provider/model" id as dsh's model option value, or null when it isn't one.
export const valueOfId = (id: string) => {
  const at = String(id).indexOf("/");
  return at > 0 ? JSON.stringify([id.slice(0, at), id.slice(at + 1)]) : null;
};
