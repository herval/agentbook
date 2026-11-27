// What the page says of agents, threads and workspaces in words: an agent's name with its machine, what a thread is
// doing, where a workspace is, when a routine runs. Ported from the old page as they were; `S` reads the store.
import { baseId, clock, dayTime, plural } from "./format.ts";
import { agentOf, getApp } from "./store.ts";
import { drivenRuntime, isRuntimeId, RUNTIMES, runtimeInfo, runtimeOfThread } from "../../plugin/shared/runtimes.ts";
import type { MachineRow } from "./types.ts";

// An agent's place in a list of them, as a sort key: Claude Code first, then this machine's agents, then the oldest.
export const seniority = (x: { id?: string; machine?: string | null; created?: string | null }, data: { machine?: string | null } | null = getApp().data) => `${baseId(x.id) === "claude" ? 0 : 1}${x.machine === data?.machine ? 0 : 1}${x.created}`;

const S = {
  get data() {
    return getApp().data;
  },
};
// A path the way its machine's person writes it: ~/dev/agentbook.
export function tildeOn(machine, p) {
  const home = machineInfo(machine).home;
  return home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p;
}
// Always include the machine in an agent's display name, even with only one machine connected: "Claude @ hervalm5".
export const many = () => (S.data?.machines || []).length > 1;
// The machine is the one it runs on. An OpenClaw agent runs on its gateway's ("brick"), which agentbook reaches
// through a machine of yours, so it says both: "Moneynuggs @ brick via hervalm5".
export const agentName = (id) => {
  const a = agentOf(id);
  if (a.host && a.machine && a.host !== a.machine) return `${a.name} @ ${a.host} via ${a.machine}`;
  const where = a.host || a.machine;
  return where ? `${a.name} @ ${where}` : a.name;
};
// Agents by name, so each agent's machines sit together, this machine's first.
export const sortAgents = (list) => [...list].sort((a, b) => a.name.localeCompare(b.name) || Number(a.machine !== S.data?.machine) - Number(b.machine !== S.data?.machine) || String(a.machine).localeCompare(String(b.machine)));
// What to say of something sent to a machine that hasn't answered: it's off (it waits for it to be back), or it's
// on and not done with it yet (it may be waiting for an OK there).
export const waits = (d, what) => (d.offline ? `${d.waiting} is off: ${what} when it's back.` : `${d.waiting} hasn't answered yet: ${what} once it does (it may want an OK there: agentbook-cli approve).`);
// Why an agent is offline: its machine isn't connected to agentbook, or agentbook can't reach the gateway its
// agents run behind (OpenClaw's), since when, and what went wrong.
export function offlineWhy(a) {
  const l = a.link;
  if (!l || (S.data.machines || []).some((m) => m.name === a.machine && !m.online)) return `${a.machine} isn't connected to agentbook.`;
  if (l.state === "off") return "OpenClaw is off here (AGENTBOOK_OPENCLAW=0).";
  if (l.state === "pairing") return "Waiting for you to approve agentbook on OpenClaw's gateway. Add agents says how.";
  if (connecting(a)) return "Connecting to OpenClaw…";
  const why = l.error ? `: ${l.error.replace(/\.$/, "")}.` : ".";
  return `Can't reach OpenClaw${l.since ? ` since ${clock(l.since)}` : ""}${why}${/tries again|trying again/i.test(why) ? "" : " agentbook keeps trying."}`;
}
// Not reached yet, rather than lost: agentbook has only just started trying.
export const connecting = (a) => a.link?.state === "connecting" && !a.link.since;
// An agent is active while a post of its is working, idle when it's there with nothing running, or offline.
export const presence = (a) => (a.offline ? "offline" : a.working ? "active" : "idle");
export const VERB = { working: "is working", needs: "needs you", waiting: "is waiting for its owner", idle: "is waiting for a prompt", done: "is idle" };
// What a post on a machine that's off is doing now, nobody knows (its agent says "offline", its chip "Off"). One you
// archived and that isn't running or waiting on anyone says so, not "idle".
export const archivedNow = (s) => !!s.archived && !["working", "needs", "waiting"].includes(s.effective);
export const verb = (s) => (s.offline && s.effective !== "done" ? "" : archivedNow(s) ? "is archived" : VERB[s.effective] || "");
export const listVerb = (s) => verb(s) || (s.offline ? "its machine is off" : "");
// Whose a post or agent is, when it isn't yours: "@alice".
export const ownerOf = (agentId) => agentOf(agentId).owner || "";
export const postOwner = (s) => s.owner || ownerOf(s.agent);
// Where what's typed into a Claude Code session is typed: Claude Desktop's Code tab, VS Code (s.app, from the
// hook's hello), or a terminal.
export function appName(s) {
  return { desktop: "Desktop", vscode: "VS Code" }[s?.app] || null;
}
export function typedIn(s) {
  return appName(s) || "the terminal";
}
// What you sent to one idle where nothing of agentbook's is waiting to wake it (its Wake hook gave up, or it has none).
export function stuckLine(s) {
  return `${s?.label || "It"} is idle in ${typedIn(s)}, where agentbook can't wake it: it gets this once someone types there.`;
}
// It was idle there too, and agentbook-cli is waking it with a message from another session (post.deliver's nudge).
export function nudgedLine(s) {
  return `${s?.label || "It"} was idle in ${typedIn(s)}: agentbook is waking it to read this.`;
}
// A loop runs again on its own: a cron, a /loop someone started, a Codex automation's heartbeat into its thread.
// What else a session schedules is a check Claude set itself: it looks again once, when it said.
export const repeats = (l) => l.repeats !== false;
// You post to your own agents only, ones a runtime on their machine runs, as it says (`runtime`), and Claude Code's
// (DEFAULT_KIND) whatever it says.
export const startable = (a) => (isRuntimeId(a.runtime) || a.kind === DEFAULT_KIND) && a.mine !== false && !inactiveAgent(a);
// The runtime that drives a thread of yours on a machine, as its machine says it runs now (its `rt`): not Claude
// Code's own sessions, nor a cloud's. agentbook hands it what you send, and stops it, through that runtime; and its
// app is where else what it asks waits.
export const drivenBy = (s: { proc?: string | null; cloud?: string | null; rt?: unknown } | null | undefined) => (s?.rt ? drivenRuntime(s) : null);
// The kind of agent a new thread goes to when nothing picks another: the runtime an agent with no kind is
// (shared/runtimes.ts's runtimeInfo, Claude Code's).
export const DEFAULT_KIND = runtimeInfo().id;
// What an agent's runtime lets it do, by its kind (shared/runtimes.ts); nothing for one whose kind the page doesn't
// know (a private agent's, "").
export const kindCaps = (kind: string | null | undefined) => (isRuntimeId(kind) ? RUNTIMES[kind].caps : null);
// A thread's runtime (shared/runtimes.ts), by where it runs and its proc: what it can do, what it's called, and for
// one in a cloud, how the page says where ("In Codex Cloud").
export const runtimeOfRow = (s: { proc?: string | null; cloud?: string | null } | null | undefined) => RUNTIMES[runtimeOfThread(s)];
// An agent of yours you've hidden: off your sidebar and your feed.
export const hiddenAgent = (a) => a.mine !== false && !!a.hidden;
export const inactiveAgent = (a) => !!(a?.inactive ?? a?.hidden);
// Your workspaces, each with its checkouts on every machine: the folders it was given, and for a repo, every
// folder a machine reports that's a clone of it. A session belongs to the workspaces whose checkouts it ran
// in (or below). Worked out once per state.
export const machineOf = (x) => x.machine || S.data.machine;
export const machineInfo = (name): Partial<MachineRow> => (S.data.machines || []).find((m) => m.name === name) || {};
export const repoName = (key) => String(key || "").replace(/^github\.com\//, "");
export const onGitHub = (ws) => /^github\.com\/[^/]+\/[^/]+$/.test(ws?.repo || "");
// The GitHub repo a workspace can be cloned from: its own, or for a folder, its checkout's remote.
export const gitHubOf = (w) => [w.repo, ...w.checkouts.map((c) => c.remote)].find((repo) => onGitHub({ repo })) || "";
export let wsMemo = { data: null, list: [] };
export function workspaces() {
  if (wsMemo.data === S.data) return wsMemo.list;
  const folders = S.data.folders || [];
  const list = (S.data.workspaces || []).map((w) => {
    const given = (machine, root) => w.folders.some((f) => f.machine === machine && f.path === root);
    const checkouts = folders.filter((f) => (w.repo && f.remote === w.repo) || given(machineOf(f), f.root)).map((f) => ({ ...f, machine: machineOf(f) }));
    for (const f of w.folders) if (!checkouts.some((c) => c.machine === f.machine && c.root === f.path)) checkouts.push({ machine: f.machine, root: f.path, name: f.path.split("/").pop(), sessions: 0 });
    checkouts.sort((a, b) => (b.last || "").localeCompare(a.last || ""));
    // A repo being cloned when it was added, on the machine that's cloning it (or why that failed).
    const cloning = w.repo ? (S.data.cloning || []).filter((c) => c.repo === w.repo).map((c) => ({ ...c, machine: machineOf(c) })) : [];
    // Its threads running (`live`) and when it was last worked in (`used`) are the server's.
    return { ...w, checkouts, cloning, live: w.live || 0, used: w.used || w.created || "" };
  });
  wsMemo = { data: S.data, list };
  return list;
}
export const workspaceIds = (s) => s?.workspaces || [];
export const wsWhere = (w) =>
  [w.repo ? repoName(w.repo) : null, ...w.checkouts.map((c) => `${many() ? `${c.machine}: ` : ""}${tildeOn(c.machine, c.root)}`), ...(w.cloning || []).map((c) => c.error || `${many() ? `${c.machine}: ` : ""}cloning into ${tildeOn(c.machine, c.dir)}`)].filter(Boolean).join("\n");
// What to say under a workspace's name, if anything: where it's checked out, or that it isn't yet.
export function wsNote(w): string {
  const machines = [...new Set(w.checkouts.map((c) => c.machine))];
  const clone = !machines.length && w.cloning?.[0];
  return clone ? (clone.error ? "couldn't clone" : "cloning…") : w.repo && !machines.length ? "not cloned yet" : many() ? machines.join(", ") : "";
}
export function everyWords(ms) {
  const m = Math.max(1, Math.round(ms / 60e3));
  const each = (n, unit) => (n === 1 ? `Every ${unit}` : `Every ${n} ${unit}s`);
  if (m % 10080 === 0) return each(m / 10080, "week");
  if (m % 1440 === 0) return each(m / 1440, "day");
  if (m % 60 === 0) return each(m / 60, "hour");
  return each(m, "minute");
}
export function ruleWords(rule) {
  const p = Object.fromEntries(String(rule).replace(/^RRULE:/i, "").split(";").map((kv) => kv.split("=")));
  const n = Number(p.INTERVAL) || 1;
  const first = (v) => String(v).split(",")[0];
  const at = p.BYHOUR != null ? ` at ${pad2(first(p.BYHOUR))}:${pad2(first(p.BYMINUTE ?? 0))}` : "";
  const days = p.BYDAY ? p.BYDAY.split(",").map((d) => BYDAY[d.slice(-2)]).filter((d) => d != null).sort() : null;
  const dayWords = !days?.length ? null : days.join() === "1,2,3,4,5" ? "Weekdays" : days.join() === "0,6" ? "Weekends" : listWords(days.map((d) => `${DAYS[d]}s`));
  if (p.FREQ === "MINUTELY") return everyWords(n * 60e3);
  if (p.FREQ === "HOURLY") return n % 24 === 0 ? `${dayWords || everyWords(n * 3600e3)}${at}` : `${everyWords(n * 3600e3)}${p.BYMINUTE && first(p.BYMINUTE) !== "0" ? `, at :${pad2(first(p.BYMINUTE))}` : ""}`;
  if (p.FREQ === "DAILY") return `${dayWords || everyWords(n * 86400e3)}${at}`;
  if (p.FREQ === "WEEKLY") return `${dayWords ? `${dayWords}${n > 1 ? `, every ${n} weeks` : ""}` : everyWords(n * 7 * 86400e3)}${at}`;
  if (p.FREQ === "MONTHLY") return `${p.BYMONTHDAY ? `The ${ordinal(Number(first(p.BYMONTHDAY)))} of every month` : n === 1 ? "Every month" : `Every ${n} months`}${at}`;
  return String(rule);
}
export const listWords = (xs) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
export const pad2 = (n) => String(n).padStart(2, "0");
export const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
// An RFC 5545 rule, as Codex's automations keep them ("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0"),
// in words. Its times are this machine's.
export const BYDAY = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
export const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th"}`;
// When a routine runs, in words: "Weekdays at 08:00", "Every 4 hours", "Once, Mon, Oct 12, 09:00". A time of
// day is in the routine's own time zone, which it names when that isn't yours; one kept in UTC (claude.ai's,
// made without a zone) says its time in yours when it's the same day either way.
export function scheduleWords(s) {
  if (!s) return "No schedule";
  if (s.kind === "every") return everyWords(s.everyMs);
  if (s.kind === "at") return s.at ? `Once, ${dayTime(s.at)}` : "Once";
  if (s.kind === "on-exit") return "When a command it watches ends";
  if (s.kind === "stream") return "When a command it watches prints something";
  if (s.kind === "paced") return "When Claude picks, each time";
  if (s.kind === "rrule") return ruleWords(s.rule);
  if (s.kind !== "cron") return s.kind;
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  let zone = s.tz && s.tz !== local ? `, ${s.tz.split("/").pop().replace(/_/g, " ")} time` : "";
  const f = String(s.expr || "").trim().split(/\s+/);
  if (f.length === 5 && s.tz === "UTC" && /^\d+$/.test(f[0]) && /^\d+$/.test(f[1]) && f[2] === "*" && f[3] === "*") {
    const t = new Date();
    t.setUTCHours(Number(f[1]), Number(f[0]), 0, 0);
    if (f[4] === "*" || t.getDate() === t.getUTCDate()) {
      [f[0], f[1]] = [String(t.getMinutes()), String(t.getHours())];
      zone = "";
    }
  }
  if (f.length === 5) {
    const [min, hour, dom, mon, dow] = f;
    const step = (x) => Number(x.match(/^\*\/(\d+)$/)?.[1]) || 0;
    const anyDay = dom === "*" && mon === "*" && dow === "*";
    if (step(min) && hour === "*" && anyDay) return everyWords(step(min) * 60e3);
    if (/^\d+(,\d+)+$/.test(min) && hour === "*" && anyDay) {
      const ms = min.split(",").map(Number).sort((a, b) => a - b);
      const gaps = new Set(ms.map((m, i) => (ms[(i + 1) % ms.length] - m + 60) % 60 || 60));
      return `${gaps.size === 1 ? everyWords([...gaps][0] * 60e3) : `${ms.length} times an hour`}, at ${listWords(ms.map((m) => `:${pad2(m)}`))}`;
    }
    if (/^\d+$/.test(min) && (hour === "*" || step(hour)) && anyDay) return `${everyWords((step(hour) || 1) * 3600e3)}${min === "0" ? "" : `, at :${pad2(min)}`}`;
    if (/^\d+$/.test(min) && /^\d+$/.test(hour) && mon === "*") {
      const at = `at ${pad2(hour)}:${pad2(min)}${zone}`;
      if (dom === "*" && dow === "*") return `Every day ${at}`;
      if (dom === "*" && dow === "1-5") return `Weekdays ${at}`;
      if (dom === "*" && (dow === "0,6" || dow === "6,0")) return `Weekends ${at}`;
      if (dom === "*" && /^[0-7](,[0-7])*$/.test(dow)) return `${listWords(dow.split(",").map((d) => `${DAYS[Number(d) % 7]}s`))} ${at}`;
      if (/^\d+$/.test(dom) && dow === "*") return `The ${ordinal(Number(dom))} of every month ${at}`;
    }
  }
  return `${f.join(" ")}${zone}`;
}
// How long until then: "in 5m", "in 3h", "in 2d".
export function fromNow(iso) {
  const s = (Date.parse(iso) - Date.now()) / 1000;
  if (s < 60) return "any moment";
  if (s < 3600) return `in ${Math.round(s / 60)}m`;
  if (s < 86400) return `in ${Math.round(s / 3600)}h`;
  return `in ${Math.round(s / 86400)}d`;
}
// A check Claude set itself says when it checks back; it doesn't run on a schedule.
export const routineWhen = (r) => (r.schedule?.kind === "paced" && r.repeats === false ? `Checks back${r.enabled && r.next ? ` ${fromNow(r.next)}, at ${clock(r.next)}` : ""}` : `${scheduleWords(r.schedule)}${r.enabled && r.next ? `, next ${fromNow(r.next)}` : ""}`);
