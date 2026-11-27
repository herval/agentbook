// What a machine's agents did before agentbook followed them, for the welcome card (web/components/welcome/): each past
// session as its agent, its day and its folder, so the page can count any range, and leave agents or folders out,
// without asking the machine again. The machine reads them (plugin/cli/history.ts) and brings in the ones the person
// picks (history.pick); until they pick, nothing from before goes up.

// How far back the card's chart goes, in days. "All" counts every session the machine lists, older ones too.
export const HISTORY_DAYS = 60;
// The most sessions a read lists, newest first: past that, "All" counts what's listed.
export const HISTORY_MAX = 5000;

export interface HistoryAgent {
  // The runtime (shared/runtimes.ts), and the agent its threads go to.
  kind: string;
  agent: string;
  name: string;
  // How many days back its own app keeps sessions, when it deletes older ones (Claude Code's cleanupPeriodDays).
  keeps?: number | null;
}

// A past session: [agent's index in `agents`, days before today (0 is today, in the machine's time zone), folder's
// index in `folders`, or -1 for none].
export type HistorySession = [number, number, number];

export interface HistoryPick {
  // The oldest a session may have been active to come in, or null for all of them. Absent: nothing from before.
  from: string | null;
  out_agents: string[];
  out_folders: string[];
  at: string;
}

export interface HistoryProgress {
  total: number;
  done: number;
  by: Record<string, { total: number; done: number }>;
  started: string;
  finished?: string | null;
  error?: string | null;
}

export interface HistoryRead {
  machine: string;
  // No pick made yet: the card asks. A machine that logged in before this existed, or whose person answered at the
  // terminal, has picked.
  pending: boolean;
  pick?: HistoryPick | null;
  today: string;
  agents: HistoryAgent[];
  folders: string[];
  sessions: HistorySession[];
  // Sessions not listed past HISTORY_MAX.
  more?: number;
  progress?: HistoryProgress | null;
}

// The days a range keeps, `null` for all of them.
export type Range = number | null;

export interface Leaveouts {
  agents: ReadonlySet<string>;
  folders: ReadonlySet<string>;
}

export const NONE: Leaveouts = { agents: new Set(), folders: new Set() };

// The sessions a pick brings in: in the range, with their agent and folder in.
export function picked(h: HistoryRead, range: Range, out: Leaveouts = NONE): HistorySession[] {
  if (range === 0) return [];
  return h.sessions.filter(([a, d, f]) => (range == null || d < range) && !out.agents.has(h.agents[a]?.kind) && !(f >= 0 && out.folders.has(h.folders[f])));
}

// Per agent, how many a pick brings in.
export function countBy(h: HistoryRead, list: HistorySession[]): Record<string, number> {
  const by: Record<string, number> = {};
  for (const [a] of list) {
    const k = h.agents[a]?.kind;
    if (k) by[k] = (by[k] || 0) + 1;
  }
  return by;
}

// Per day (index 0 is today) and agent, for the chart: days[d][a].
export function perDay(h: HistoryRead, days = HISTORY_DAYS, out: Leaveouts = NONE): number[][] {
  const grid = Array.from({ length: days }, () => new Array(h.agents.length).fill(0));
  for (const [a, d, f] of h.sessions) {
    if (d >= days || out.agents.has(h.agents[a]?.kind) || (f >= 0 && out.folders.has(h.folders[f]))) continue;
    grid[d][a]++;
  }
  return grid;
}

// Per folder, how many in the range (agents left out don't count), most first.
export function perFolder(h: HistoryRead, range: Range, outAgents: ReadonlySet<string> = new Set()): { folder: string; n: number }[] {
  const n = new Map<string, number>();
  for (const [a, d, f] of h.sessions) {
    if (f < 0 || (range != null && d >= range) || outAgents.has(h.agents[a]?.kind)) continue;
    n.set(h.folders[f], (n.get(h.folders[f]) || 0) + 1);
  }
  return [...n].map(([folder, k]) => ({ folder, n: k })).sort((x, y) => y.n - x.n || x.folder.localeCompare(y.folder));
}

// Where a range starts: its first day's midnight. Run on the machine, so that's in its time zone, as its days are;
// the page sends the range, never a date.
export function pickFrom(range: Range, now = new Date()): string | null {
  if (range == null) return null;
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - Math.max(0, range - 1));
  return d.toISOString();
}

// Days before today, in this process's time zone: 0 for any time today.
export function daysAgo(t: number, now = new Date()): number {
  const a = new Date(now);
  a.setHours(0, 0, 0, 0);
  const b = new Date(t);
  b.setHours(0, 0, 0, 0);
  return Math.max(0, Math.round((a.getTime() - b.getTime()) / 864e5));
}
