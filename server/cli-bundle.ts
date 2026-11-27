// agentbook-cli and the plugin, as one .tar.gz, for the cloud machines this server makes, which always get agentbook
// at this server's version, downloaded from it. bin/agentbook-server packs it
// into the server's data folder before the server starts, since the server itself can't read the plugin (Node's
// permission model gives it server/, plugin/shared/ and its data). The server only hands the file on, and only to
// whoever has a ticket: a build's or a machine's script, for an hour.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SERVER_HOME } from "./config.ts";

const FILE = () => path.join(SERVER_HOME, "cli-bundle.tgz");
const TICKET_MS = Number(process.env.AGENTBOOK_BUNDLE_TICKET_MS || 3600e3);

// { file, version, size }, or null: this server was started without one (not by bin/agentbook-server).
export function bundle(): { file: string; version: string; size: number } | null {
  try {
    const st = fs.statSync(FILE());
    let version = "";
    try {
      version = fs.readFileSync(path.join(SERVER_HOME, "cli-bundle.version"), "utf8").trim();
    } catch {}
    return st.size ? { file: FILE(), version, size: st.size } : null;
  } catch {
    return null;
  }
}

// Tickets: what a script downloads with, kept in memory. Each is for one person's one build or machine (`about`),
// and may also say who git is on GitHub while it runs (`git`: their id here), for an hour.
export interface Ticket {
  about: string;
  uid: string;
  git: boolean;
  until: number;
}
const tickets = new Map<string, Ticket>();
export function ticket({ about, uid, git = false, ms = TICKET_MS }: { about: string; uid: string; git?: boolean; ms?: number }): string {
  const now = Date.now();
  for (const [t, x] of tickets) if (x.until < now) tickets.delete(t);
  const t = crypto.randomBytes(24).toString("base64url");
  tickets.set(t, { about, uid, git: !!git, until: now + ms });
  return t;
}
export const ticketOf = (t: string | null | undefined): Ticket | null => {
  const x = tickets.get(String(t || ""));
  return x && x.until > Date.now() ? x : null;
};
// A build ended, or a machine is set up: its ticket works no more.
export function endTickets(about: string): void {
  for (const [t, x] of tickets) if (x.about === about) tickets.delete(t);
}
