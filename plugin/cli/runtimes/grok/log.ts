// What Grok keeps of a session, read-only: the ACP updates it sent, one JSON line each, in
// ~/.grok/sessions/<folder, URL-encoded>/<session>/updates.jsonl (GROK_HOME moves ~/.grok). Each line is
// { timestamp, method, params: { sessionId, update } }, `method` session/update or, for Grok's own kinds
// (turn_completed, background_tasks…), _x.ai/session/update. It's what `session/load` replays.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const grokHome = () => process.env.GROK_HOME || path.join(os.homedir(), ".grok");

// The file, for a session in `cwd`; else wherever it is (a session whose folder agentbook has spelled another way).
export function updatesFile(id: string, cwd: string | null | undefined): string | null {
  if (!/^[\w-]+$/.test(id)) return null;
  const sessions = path.join(grokHome(), "sessions");
  if (cwd) {
    const file = path.join(sessions, encodeURIComponent(cwd), id, "updates.jsonl");
    if (fs.existsSync(file)) return file;
  }
  try {
    for (const dir of fs.readdirSync(sessions)) {
      const file = path.join(sessions, dir, id, "updates.jsonl");
      if (fs.existsSync(file)) return file;
    }
  } catch {}
  return null;
}

export interface LoggedUpdate {
  at: string | null;
  method: string;
  update: Record<string, any>;
}
export function readUpdates(id: string, cwd: string | null | undefined): LoggedUpdate[] | null {
  const file = updatesFile(id, cwd);
  if (!file) return null;
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const out: LoggedUpdate[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line);
      const u = m?.params?.update;
      if (!u || typeof u !== "object") continue;
      const ms = Number(m.params?._meta?.agentTimestampMs) || Number(m.timestamp) * 1000;
      out.push({ at: Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null, method: String(m.method || ""), update: u });
    } catch {}
  }
  return out;
}
