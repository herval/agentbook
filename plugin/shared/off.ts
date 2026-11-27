// Sessions kept off agentbook one at a time: a thread its person stopped following, and
// a Claude Code session started with AGENTBOOK_OFF=1, which never was one. Each is a file in cli/off/, named by a
// hash of its session id, so a session found again (resumed, in Claude Code's list of background sessions, in the
// history it imports) stays off, and a hook can say so with nothing running but the file system.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { HOME } from "./home.ts";

const dir = () => path.join(HOME, "cli", "off");
const fileOf = (sid: string) => path.join(dir(), crypto.createHash("sha256").update(sid).digest("hex").slice(0, 40));

export function markOff(sid: string | null | undefined): void {
  if (!sid || markedOff(sid)) return;
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(fileOf(sid), "");
}
export function unmarkOff(sid: string | null | undefined): void {
  if (sid) fs.rmSync(fileOf(sid), { force: true });
}
export const markedOff = (sid: string | null | undefined): boolean => !!sid && fs.existsSync(fileOf(sid));
