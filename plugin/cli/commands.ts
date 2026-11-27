// agentbook-cli's commands, from this machine's shell:
//   login <server> [--name N]   log this machine in to an agentbook-server: approve the code it shows, signed in
//   logout                      revoke this machine's token on its server, and forget it
//   status                      the daemon: which server, whether it's reachable, what's waiting to go up
//   up, down                    start the daemon in the background, or stop it
//   allow|deny <folder>, gate, approve [id] [--no], log [n]    the gate (gate.ts)
//   openclaw [pair <setup code> | pair --url wss://… --token T | off]   this machine's OpenClaw gateway, paired
//                               here, so its code or token never passes through the server
//   fold <copy> <thread>        a copy of a thread's conversation Claude Code started on a resume, made that thread
//                               again (the daemon's /local/fold): what it said, and the session it goes on in
//   seat add|login|remove|list  a shared Linux machine's people, as root: a Linux user and an agentbook-cli each (seats.ts)
//   claude …, dev …             Claude Code with agentbook's channel (bin/agentbook-cli, which never comes here)
//   update [<version>|auto|ask|off|status]   take what main has now, or say whether it does by itself (update.ts)
//   help, version               what it can do, and which version this is: these two need no daemon and no login
//   webui [--no-open]           agentbook on this machine alone, as one process (`agentbook webui`, `agentbook up`,
//                               and `local` from before): the page on 127.0.0.1:4310 with its own data folder, served
//                               by this CLI's daemon, which logs in to it once it has its first account (webui.ts).
//                               `webui off`: no page here from now on (mesh.ts)

import { setTimeout as sleep } from "node:timers/promises";
import { execFile, spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { CLI_LOG, NOT_AGENTBOOK, PLUGIN_ROOT, PORT, VERSION, cleanEnv, localFetch, openLog, outdated, startRoot, stopCli, stopUnproved, updateUnderWay } from "../lib/common.ts";
import { machineName } from "../shared/ids.ts";
import { RUNTIMES, type RuntimeId } from "../shared/runtimes.ts";
import { CLI_HOME, DB_FILE, HOME } from "../shared/store.ts";
import { createGate } from "./gate.ts";
import { ROOT, machineLogin, onNoAccount } from "../shared/machine-login.ts";
import { relayLogin, relayLogout } from "./relay-login.ts";
import type { PageKeys } from "./page-keys.ts";
import { fingerprint, pinOf } from "./signatures.ts";
import { codexConfig, installedByClaude, removeCodexEntry } from "./uninstall.ts";
import { isLocal, keepPageFrom, pageUrl, serverRepo } from "./webui.ts";
import { seatCommand } from "./seats.ts";
import { updateClaudePlugin } from "./claude-plugin.ts";
import { installOf, updateCommand, updateMode } from "./update.ts";
import { copyWhole, usersIn } from "../shared/storage/before.ts";
import { CORRUPT } from "../shared/storage.ts";
import type { Health, Vouched } from "../lib/common.ts";
import { BUNDLE_FILE, bundledServer, CODE_ROOT } from "../shared/bundle.ts";

const DEVICE = () => path.join(HOME, "cli", "device.json");
// In dev mode a session's plugin is a copy; the repo is beside AGENTBOOK_PLUGIN_DIR.
const pluginDir = () => process.env.AGENTBOOK_PLUGIN_DIR || PLUGIN_ROOT || CODE_ROOT;

// What the daemon's loopback routes answer: what each route says (`T`), its HTTP status, and why it refused (`error`).
interface Answer {
  error?: string;
}
type Answered<T> = T & Answer & { status: number; pid?: number };
// GET /status: its machine, its server and how it's reaching it (uplink.ts's status), and its drivers'.
interface Status {
  machine?: string;
  pid?: number;
  page?: string | null;
  pages?: { pages: { name: string; site: string | null; path: string | null }[]; not_linked: { name: string; why: string }[]; why: string | null } | null;
  server?: string | null;
  connected?: boolean;
  error?: string | null;
  save_failing?: string | null;
  fault?: { message: string; count: number; at: string };
  signed_out?: string;
  signed_out_tried?: string;
  blocked?: string;
  waiting?: number;
  too_big?: { count: number; last: { kind: string; post: string | null; bytes: number; at: string } };
  parked?: number;
  gap?: { from: number; to: number };
  update?: string;
  drivers?: Record<string, string | { enabled?: boolean; connected?: boolean; error?: string | null }>;
}
// GET /gate: whose machine it is, what it shares, what waits for an OK here, and whether callers need its key.
interface GateInfo {
  owner?: string | null;
  shared?: string[];
  waiting?: { cid: string; kind: string; by: string; at: string; args: unknown }[];
  keyed?: boolean;
  settings?: { local_key_since?: string };
  key_waits?: { threads: string[]; lines?: number } | null;
}
// How this machine reaches OpenClaw (GET /local/openclaw).
interface OpenclawSaid {
  mode?: string;
  connected?: boolean;
  state?: string;
  url?: string;
  requestId?: string;
  error?: string | null;
}
// A cloud agent's connection here (GET /local/remote).
interface RemoteSaid {
  connected?: boolean;
  org?: string;
  github?: boolean;
  budget?: number | null;
  error?: string | null;
}

// The daemon on this machine, when it's running: an answer from its loopback routes, or null. Signed with the key in
// its folder (cli/local.key), for what only agentbook-cli here may do, and never showing it: what answers proves it's
// agentbook-cli, or is this person's (one from before signed calls), or this throws (common.ts, vouch). `pid`, from
// one from before, is the one listening, not what it says.
async function daemon<T extends object = Answer>(method: string, route: string, body?: unknown, port = PORT, timeout = 5000): Promise<Answered<T> | null> {
  let r: { res: Response } & Vouched;
  try {
    r = await localFetch(`http://127.0.0.1:${port}/api${route}`, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeout) });
  } catch (e) {
    if (e.code === NOT_AGENTBOOK) throw e;
    return null;
  }
  const json = (await r.res.json().catch(() => ({}))) as T & Answer;
  // One from before takes the key only as it is, for what only agentbook-cli may do: it's started again from this
  // version rather than shown the key.
  if (r.res.status === 403 && r.how === "own") json.error = `${json.error || "agentbook-cli refused that."} agentbook-cli here is older than this command: run agentbook-cli down, then agentbook-cli up, and try again.`;
  return { status: r.res.status, ...json, ...(r.how === "own" && r.pid ? { pid: r.pid } : {}) };
}

// Plain HTTP is for loopback and tailnets only: anywhere else a device token would cross the network in the clear.
// AGENTBOOK_ALLOW_HTTP=1 allows it anyway, for whoever accepts that on a network of their own.
export function plainOk(url: URL) {
  if (process.env.AGENTBOOK_ALLOW_HTTP === "1") return true;
  const h = url.hostname.replace(/^\[|\]$/g, "");
  if (["localhost", "127.0.0.1", "::1"].includes(h) || h.endsWith(".ts.net")) return true;
  const m = /^100\.(\d+)\.\d+\.\d+$/.exec(h);
  return !!m && Number(m[1]) >= 64 && Number(m[1]) <= 127;
}

// Whether a server is on another machine (not loopback): then this machine takes what can run something only signed.
const elsewhere = (server: string | null | undefined) => {
  try {
    return !["localhost", "127.0.0.1", "::1"].includes(new URL(server).hostname.replace(/^\[|\]$/g, ""));
  } catch {
    return !!server;
  }
};
const UNSIGNED_HERE = "Its server is on this machine, so it takes what that server sends unsigned.";
const NEEDS_KEYS = "It takes nothing that can run something until it keeps your passkeys: within a day of logging it in, turn on Signing for it from its row in Machines, on your profile. After that, log it in again.";
// This machine's login: its server, its token there, its name, and whose it is.
interface Link {
  server: string;
  token: string;
  name: string | null;
  user?: string;
}
const saved = (): Link | null => {
  try {
    return JSON.parse(fs.readFileSync(DEVICE(), "utf8"));
  } catch {
    return null;
  }
};
export function save(link: Link) {
  fs.mkdirSync(path.dirname(DEVICE()), { recursive: true });
  fs.writeFileSync(DEVICE(), JSON.stringify(link, null, 2) + "\n", { mode: 0o600 });
}

// The daemon, started in the background (as the hooks start it), and stopped.
// One older than this plugin (an update since it started) is stopped and started again from this one. It starts with
// the person's environment, not a session's it was run from (cleanEnv). While it's updating itself, that's what
// stops and starts it; a version that didn't start here gives way to the one before it (startRoot).
// `args` and `env`: for the daemon only (`run --webui`).
async function startDaemon(args: string[] = [], env: Record<string, string> = {}) {
  if (updateUnderWay()) return false;
  const root = startRoot(pluginDir());
  // One that can't prove it's agentbook-cli, where this machine's has, is stopped first (common.ts, stopUnproved).
  const h = await daemon<Health>("GET", "/health").catch(async (e) => {
    if (await stopUnproved(e)) return null;
    throw e;
  });
  if (h && !(outdated(h, root) && (await stopCli(h, 2500, h.pid)))) return false;
  const log = openLog(CLI_LOG);
  spawn(process.execPath, [path.join(root, "cli", "main.mjs"), "run", ...args], { detached: true, stdio: ["ignore", log, log], env: cleanEnv(env) }).unref();
  for (let i = 0; i < 50; i++) {
    await sleep(150);
    if (await daemon("GET", "/health")) return true;
  }
  throw new Error(`agentbook-cli didn't start: see ${CLI_LOG}`);
}
async function stopDaemon() {
  let s;
  try {
    s = await daemon<Status>("GET", "/status");
  } catch (e) {
    if (await stopUnproved(e, 4000)) return true;
    throw e;
  }
  if (!s?.pid) return false;
  try {
    process.kill(s.pid, "SIGTERM");
  } catch {}
  for (let i = 0; i < 40 && (await daemon("GET", "/health")); i++) await sleep(100);
  return true;
}

// What only the person says, before anything goes up: whether the past goes too, and whether Codex gets agentbook's
// tools in its own settings. From flags, what they said at an earlier login, or asked here. With nobody at the
// terminal (an agent installing it), both are no. Kept in gate.json, which the server can't change.
type Print = (line: string) => void;
async function consent(args: string[], { server, print }: { server: string; print: Print }) {
  const had = createGate({ home: HOME }).settings();
  const flag = (yes: string, no: string) => (args.includes(yes) ? true : args.includes(no) ? false : undefined);
  const codexHere = process.env.AGENTBOOK_CODEX !== "0" && process.env.AGENTBOOK_CODEX_MCP !== "0" && fs.existsSync(path.join(os.homedir(), ".codex"));
  const ask = process.stdin.isTTY && process.stdout.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  const yes = async (q: string) => /^y/i.test((await ask.question(`${q} [y/N] `)).trim());
  if (ask) print(`What your agents do from now on goes to ${server}, including your prompts and what they run. Whoever runs that server can read it.`);
  try {
    const history = flag("--history", "--no-history") ?? (had.history_from !== undefined ? had.history_from === null : ask ? await yes("Send your past sessions too (Codex and Hermes from the last 14 days, every OpenClaw session)?") : false);
    const tools = flag("--codex-tools", "--no-codex-tools") ?? had.codex_tools ?? (ask && codexHere ? await yes("Add agentbook's tools to Codex, with no approval needed for them, in ~/.codex/config.toml?") : false);
    print(`${history ? "Your past sessions go too." : "Only what happens from now on goes up: --history sends your past sessions too."}${codexHere ? ` ${tools ? "Codex gets agentbook's tools in its settings." : "Codex's settings stay as they are: --codex-tools adds agentbook's tools there."}` : ""}`);
    // Updating itself is on unless they say no here, or said so before (agentbook-cli update off).
    return { history_from: history ? null : had.history_from || new Date().toISOString(), codex_tools: tools, ...(args.includes("--private") ? { private_terminals: true } : {}), ...(args.includes("--no-update") ? { update: "off" } : {}) };
  } finally {
    ask?.close();
  }
}

// Whether `home`'s machine serves its own page: `agentbook webui` ran there, and logged it in to that page.
function servesPage(home: string): boolean {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(home, "cli", "device.json"), "utf8"));
    return isLocal({ ...d, url: d.server });
  } catch {
    return false;
  }
}

// Log in: the server shows the person a code to approve on its page, signed in; the machine polls for its token.
// Log in to your account, through the relay (relay-login.ts): its page shows the code to say yes to. Then agentbook
// starts on the account's folder (--no-start leaves that to whoever runs it): agentbook-cli alone, which sends this
// machine's threads to your pages (mesh.ts), and the page too where `agentbook webui` made one.
async function accountLogin(args: string[], { print }: { print: Print }) {
  const open = (u: string) => process.platform === "darwin" && execFile("open", [u], () => {});
  const done = await relayLogin(args, { print, home: HOME, open });
  // Logged in on the machine itself: with no page, it takes your passkeys on each of your pages once more (mesh.ts).
  createGate({ home: done.home }).retake();
  if (done.renewed || args.includes("--no-start")) return done.said;
  await stopDaemon();
  const paged = servesPage(done.home);
  const up = spawnSync(process.execPath, [path.join(startRoot(pluginDir()), "cli", "main.mjs"), ...(paged ? ["webui", "--no-open"] : ["up"])], { env: { ...process.env, AGENTBOOK_HOME: done.home }, encoding: "utf8", timeout: 120e3 });
  if (up.status !== 0) return `${done.said} agentbook didn't start with it: ${(up.stderr || up.stdout).trim().split("\n")[0]}`;
  if (paged) return `${done.said} Its page is at ${pageUrl()}: sign in with Google there, with the same account.`;
  return `${done.said} agentbook-cli is running here, with no page: it sends this machine's threads to your pages, which steer it with your passkey there. To have a page here too: agentbook webui.`;
}

async function login(args: string[], { print }: { print: Print }) {
  const raw = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--name");
  if (!raw) return accountLogin(args, { print });
  const server = (/^https?:\/\//.test(raw) ? raw : `https://${raw}`).replace(/\/$/, "");
  const url = new URL(server);
  if (url.protocol === "http:" && !plainOk(url)) throw new Error(`${server} isn't HTTPS. A machine logs in over plain HTTP only to this machine or a tailnet (.ts.net, 100.64.0.0/10), so its token never crosses the network in the clear (AGENTBOOK_ALLOW_HTTP=1 allows it anyway).`);
  const asked = args.includes("--name") ? args[args.indexOf("--name") + 1] : null;
  const name = machineName(asked || process.env.AGENTBOOK_MACHINE || os.hostname().split(".")[0]);
  const start = await fetch(`${server}/api/devices/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }).catch((e) => {
    throw new Error(`Can't reach ${server}: ${e.cause?.code || e.message}`);
  });
  const req = (await start.json().catch(() => ({}))) as { error?: string; code?: string; expires_in?: number; poll?: string };
  if (!start.ok) throw new Error(req.error || `${server} answered HTTP ${start.status}.`);
  const agreed = await consent(args, { server, print });
  print(`To log this machine in as ${name}, open this, signed in, and approve it:\n\n    ${server}/#/connect?code=${req.code}\n\n(or enter ${req.code} under Agents → Add a machine → Pair directly to this page). Waiting for you…`);
  const until = Date.now() + req.expires_in * 1000;
  while (Date.now() < until) {
    await sleep(2000);
    const r = await fetch(`${server}/api/devices/poll?poll=${encodeURIComponent(req.poll)}`).catch(() => null);
    if (!r) continue;
    const body = (await r.json().catch(() => ({}))) as { error?: string; token?: string; pin?: unknown; name?: string; user?: string };
    if (r.status === 404) throw new Error(body.error || "The request expired. Run agentbook-cli login again.");
    if (!body.token) continue;
    // Your passkeys, when you connected it to take only what you sign: from now on it takes what can run something
    // only signed by one of them.
    const pinned = body.pin ? pinOf(body.pin) : null;
    const as = machineName(body.name || name);
    createGate({ home: HOME }).agree(agreed); // before the login, which is what starts it
    save({ server, token: body.token, name: as, user: body.user });
    if (pinned) createGate({ home: HOME }).importKeys(pinned);
    // A daemon that's running logs in again, under its name; one that isn't starts, so the machine is On at once
    // rather than once a Claude Code session starts it. --no-start
    // leaves that to whoever runs it (the tests run their own).
    const was = await stopDaemon();
    // Something else keeps it running (a supervisor, AGENTBOOK_SUPERVISED=1): a copy started here would hold its port.
    const kept = process.env.AGENTBOOK_SUPERVISED === "1";
    const started = !kept && (was || !args.includes("--no-start")) && (await startDaemon(), true);
    const signs = pinned ? ` It takes what can run something only when one of your passkeys signs it (${pinned.keys.map((k) => k.name || fingerprint(k.spki)).join(", ")}).` : ` ${elsewhere(server) ? NEEDS_KEYS : UNSIGNED_HERE}`;
    const runs = kept ? " agentbook-cli starts again with it in a few seconds." : started ? (was ? " agentbook-cli restarted with it." : " agentbook-cli is running with it, so it's On there now.") : " Start agentbook-cli with agentbook-cli up to have it On there.";
    const updates = installOf().kind === "none" ? "" : updateMode() === "auto" ? " It keeps itself up to date from main: agentbook-cli update off stops that." : " It doesn't update by itself here: agentbook-cli update does.";
    return `Logged in to ${server} as ${as}${as !== name ? ` (another machine there is ${name})` : ""}, @${body.user}'s.${signs}${runs}${updates}`;
  }
  throw new Error("Nobody approved it in time. Run agentbook-cli login again.");
}

async function logout(args: string[], { print }: { print: Print }) {
  if (machineLogin(HOME)) return relayLogout(args, { print, home: HOME, stop: stopDaemon });
  // Its login, or one an `agentbook connect` from before the split saved (hub.json), which the daemon uses too.
  const old = (() => {
    try {
      const h = JSON.parse(fs.readFileSync(path.join(HOME, "hub.json"), "utf8"));
      return h.url && h.token ? { server: h.url, token: h.token, name: null } : null;
    } catch {
      return null;
    }
  })();
  const link = saved() || old;
  if (!link) return "This machine isn't logged in to an agentbook-server.";
  const r = await fetch(`${link.server}/api/cli/logout`, { method: "POST", headers: { authorization: `Bearer ${link.token}` } }).catch(() => null);
  fs.rmSync(DEVICE(), { force: true });
  fs.rmSync(path.join(HOME, "hub.json"), { force: true });
  // The next server to log it in names its owner again.
  createGate({ home: HOME }).unpin();
  await stopDaemon();
  return r?.ok ? `Logged out of ${link.server}: its token there no longer works.` : `Forgot ${link.server} here, but couldn't reach it to revoke this machine's token: remove ${link.name || "this machine"} under Machines on its page.`;
}

// Databases it couldn't read and moved aside (storage.ts), from its folder: said whether it's running or not, until the
// person deletes them. Its storage's (storage.db, in the data folder), and its own from before that (in cli/).
function movedAside() {
  const found: [string, string, string][] = [];
  for (const [dir, base] of [[HOME, path.basename(DB_FILE)], [CLI_HOME, "agentbook.db"]]) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {}
    for (const n of names) if (n.startsWith(`${base}${CORRUPT}`) && !/-(wal|shm)$/.test(n)) found.push([dir, n, n.slice(`${base}${CORRUPT}`.length)]);
  }
  return found.map(([dir, n, at]) => `Its database couldn't be read, so on ${at.slice(0, 10)} at ${at.slice(11, 16).replace("-", ":")} UTC it was moved to ${path.join(dir, n)} and a new one started. What its server has is safe; what hadn't reached it is only in that copy, which you can delete once you don't need it.`);
}
const status = async () => [await running(), ...movedAside()].join("\n");
async function running() {
  const s = await daemon<Status>("GET", "/status");
  const link = saved();
  if (!s) return `agentbook-cli isn't running${link ? `; it's logged in to ${link.server} as ${link.name}` : ", and isn't logged in to a server"}. Start it with agentbook-cli up.`;
  const lines = [`agentbook-cli is running on ${s.machine} (pid ${s.pid}, port ${PORT}).${s.page ? ` It serves agentbook's page too, at ${s.page}.` : ""}`];
  const trouble = [];
  if (s.save_failing) trouble.push(`It can't save to its database: ${s.save_failing}. It goes on from memory, and what isn't saved is lost if it stops.`);
  if (s.fault && s.fault.message !== s.save_failing) trouble.push(`It kept going after an error, ${s.fault.count === 1 ? "once" : `${s.fault.count} times`}, last at ${s.fault.at.slice(11, 19)} UTC: ${s.fault.message}. Its log has the rest: ${CLI_LOG}`);
  // With no page of its own, on your account: the pages it sends its threads to (mesh.ts).
  if (s.pages) {
    const p = s.pages;
    const on = p.pages.map((x) => `${x.name} (${x.site}${x.path ? `, ${x.path}` : ""})`);
    lines.push(`It has no page of its own: ${on.length ? `it sends this machine's threads to ${on.join(", ")}, and takes what you sign there.` : "it's linked to none of your pages yet."}${p.why ? ` ${p.why}` : ""}`);
    for (const m of p.not_linked) lines.push(`  Not linked to ${m.name}: ${m.why}`);
  }
  if (!s.server) return [...lines, ...(s.pages ? [] : ["It isn't logged in to an agentbook-server, so it follows nothing yet: agentbook-cli login <server>."]), ...trouble].join("\n");
  const tried = s.signed_out_tried ? `, last at ${s.signed_out_tried.slice(0, 16).replace("T", " ")} UTC` : "";
  const away = s.signed_out ? `${s.server} stopped taking this machine's login (${s.signed_out}), so it only tries again once as each new thread starts${tried}. If it keeps refusing, log in again with agentbook-cli login ${s.server}.` : s.blocked || `Can't reach ${s.server}${s.error ? `: ${s.error}` : ""}.`;
  lines.push(s.connected ? `Connected to ${s.server}.` : away, s.waiting ? `${s.waiting} changes are waiting to go up.` : s.too_big ? "Everything else is sent." : "Everything's sent.");
  if (s.too_big) {
    const { count, last } = s.too_big;
    lines.push(`${count === 1 ? "1 change was" : `${count} changes were`} too big for its server even alone, so ${count === 1 ? "it" : "they"} didn't go up, and what came after did. The last: ${last.kind}${last.post ? ` on thread ${last.post}` : ""}, ${(last.bytes / 1024 / 1024).toFixed(1)} MB, on ${last.at.slice(0, 10)}.`);
  }
  if (s.parked) lines.push(`${s.parked} changes wait on the server: it couldn't take them yet, and will once it's updated.`);
  lines.push(...trouble);
  // A server restored from a backup older than what this machine's log keeps (uplink.ts).
  if (s.gap) lines.push(`Its server lost changes ${s.gap.from}–${s.gap.to} (restored from an older backup?), and this machine no longer keeps them: threads from then may be missing parts there.`);
  if (s.update) lines.push(s.update);
  const said = (d) => (typeof d === "string" ? d : d?.enabled === false ? "off" : d?.connected ? "connected" : d?.error ? `not connected: ${d.error}` : "not connected");
  const g = await daemon<GateInfo>("GET", "/gate").catch(() => null);
  const keyLine = keySaid(g);
  if (keyLine) lines.push(keyLine);
  for (const [k, d] of Object.entries(s.drivers || {})) lines.push(`  ${k}: ${said(d)}`);
  return lines.join("\n");
}

// What agentbook-cli's /api/gate says of the key on loopback, in words: what local_key waits for, or when it turned on
// by itself. Nothing with its server on this machine, or once its person turned it on.
function keySaid(g: GateInfo | null) {
  if (!g) return "";
  const at = (iso: string) => new Date(iso).toLocaleString();
  if (g.keyed && g.settings?.local_key_since) return `Every caller here needs agentbook-cli's key since ${at(g.settings.local_key_since)}: it turned on by itself once no thread from before was left.`;
  if (g.keyed !== false) return "";
  const w = g.key_waits;
  if (!w) return `Agents here reach agentbook-cli with no key, as you set. To ask every caller for it, set "local_key": true in ${path.join(HOME, "cli", "gate.json")}.`;
  const what = [w.threads.length ? `${w.threads.length === 1 ? "this thread ends" : "these threads end"} (${w.threads.join(", ")})` : "", w.lines ? "dsh's plugin from before closes its line" : ""].filter(Boolean);
  return `Agents here reach agentbook-cli with no key, as threads from before it did. It asks every caller for it by itself once ${what.join(" and ") || "a thread says hello or ends"}.`;
}

// The agentbook from before the split, on this machine's port with this data folder: stopped (by its pid), so
// agentbook-cli takes the port and the folder is moved in from. Anything else there is left alone, and said.
async function stopOld(print: Print) {
  const h = await daemon<Health & { home?: string }>("GET", "/health");
  if (!h || h.cli) return;
  if (h.name !== "agentbook" || (h.home && path.resolve(h.home) !== path.resolve(HOME))) throw new Error(`Something else answers on port ${PORT}: stop it, then run agentbook up again.`);
  const pid = Number(spawnSync("lsof", ["-ti", `tcp:${PORT}`, "-sTCP:LISTEN"], { encoding: "utf8" }).stdout.trim().split("\n")[0]);
  if (!pid) throw new Error(`The agentbook from before the split answers on port ${PORT}, but its process can't be found: stop it, then run agentbook up again.`);
  print(`Stopping the agentbook from before the split (pid ${pid}, port ${PORT}).`);
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 100 && (await daemon("GET", "/health")); i++) await sleep(100);
  if (await daemon("GET", "/health")) throw new Error(`It didn't stop (pid ${pid}): stop it, then run agentbook up again.`);
}
// A data folder from before the split (one database with accounts and everything, and no server data yet):
// moved in, once, after a copy of its database is kept (agentbook.db.before-split) to go back to. Its database is
// in cli/ once an agentbook-cli has started there since (cli-folder.ts), else at the top.
function moveIn({ server, admin, print }: { server: string; admin: (...a: string[]) => SpawnSyncReturns<string>; print: Print }) {
  const old = [path.join(CLI_HOME, "agentbook.db"), path.join(HOME, "agentbook.db")].find((f) => fs.existsSync(f));
  const serverDb = path.join(process.env.AGENTBOOK_SERVER_HOME || path.join(HOME, "server"), "agentbook.db");
  // Not when this machine's storage has the page's accounts: a page ran here since storage.db.
  if (!old || fs.existsSync(serverDb) || usersIn(DB_FILE) > 0) return;
  if (!usersIn(old)) return;
  const keep = path.join(CLI_HOME, "agentbook.db.before-split");
  if (!fs.existsSync(keep)) {
    fs.mkdirSync(CLI_HOME, { recursive: true });
    copyWhole(old, keep);
  }
  print(`Moving in from ${HOME} (its database as it was is kept in ${keep}).`);
  const r = admin("import", HOME, "--server", server, "--name", machineName(process.env.AGENTBOOK_MACHINE || os.hostname().split(".")[0]));
  if (r.status !== 0) throw new Error(`Moving in didn't work: ${(r.stderr || r.stdout).trim()}`);
  print(r.stdout.trim());
}
// The plugin folder sessions this CLI starts load (AGENTBOOK_PLUGIN_DIR, in dev mode), kept for when the CLI is
// started again without being told (by a hook, after a reboot).
function keepPluginDir() {
  if (!process.env.AGENTBOOK_PLUGIN_DIR) return;
  const file = path.join(HOME, "cli", "settings.json");
  let was = {};
  try {
    was = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {}
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...was, plugin_dir: process.env.AGENTBOOK_PLUGIN_DIR }, null, 2) + "\n");
}

// agentbook on this machine alone, as one process (`agentbook webui`, and `agentbook up`): the page on 127.0.0.1:4310
// (its data in ~/.agentbook/server) and this machine's sessions, both served by agentbook-cli's daemon (webui.ts),
// which logs this machine in to its page as its first account's once there is one. The agentbook it was before, a
// server and a CLI in two processes, is stopped first, and starts as one; one from before the split is moved in.
async function webui(args: string[], { print }: { print: Print }) {
  if (args[0] === "off") return webuiOff();
  if (!saved() && onNoAccount(HOME, ROOT)) return firstRunPage(args, { print });
  const link = saved();
  if (link && !isLocal({ ...link, url: link.server })) throw new Error(`This machine is logged in to ${link.server}, where its page is. To have its page here instead: agentbook cli logout, then agentbook webui.`);
  keepPageFrom();
  // The server's own checkout, or this bundle, when the server is in it (build.ts).
  const repo = serverRepo();
  const bundled = !repo && bundledServer() ? BUNDLE_FILE : null;
  if (!repo && !bundled) throw new Error(`There's no agentbook-server next to this agentbook-cli (${path.resolve(pluginDir(), "..", "server")}), so it has no page to serve. Log it in to one with agentbook-cli login <server>.`);
  const server = link ? link.server.replace(/\/$/, "") : pageUrl();
  const admin = (...a: string[]) => spawnSync(process.execPath, [...(bundled ? [bundled, "admin"] : [path.join(repo, "server", "admin.ts")]), ...a], { encoding: "utf8", env: { ...process.env, AGENTBOOK_SERVER_PORT: new URL(server).port || "80" } });
  await stopOld(print);
  keepPluginDir();
  const was = await daemon<Status>("GET", "/status");
  if (was?.page !== server) {
    if (was?.pid) await stopDaemon();
    await stopServer(server, print);
    moveIn({ server, admin, print });
    await startDaemon(["--webui"]);
    const up = async () => (await fetch(`${server}/api/health`, { signal: AbortSignal.timeout(1500) }).catch(() => null))?.ok;
    for (let i = 0; i < 60 && !(await up()); i++) await sleep(150);
    if ((await daemon<Status>("GET", "/status"))?.page !== server) throw new Error(`agentbook-cli started, but isn't serving the page at ${server}: see ${CLI_LOG}`);
  }
  updateClaudePlugin(path.resolve(pluginDir(), ".."), print);
  const open = (u: string) => process.platform === "darwin" && !args.includes("--no-open") && execFile("open", [u], () => {});
  const sessions = `this machine's sessions at http://127.0.0.1:${PORT}`;
  open(server);
  // Its person signs in with the Google account this machine logged in with; a page whose machine isn't logged in
  // has nobody to sign in yet.
  const signIn = machineLogin(HOME) ? " Sign in there with Google, with the account you logged in with." : " This machine isn't on an agentbook account yet: run agentbook login, then sign in there.";
  return `agentbook is running: its page at ${server} and ${sessions}, in one process.${signIn}`;
}
// `agentbook webui off`: no page here from now on. agentbook-cli starts again without it, and sends this machine's
// threads to your other pages (mesh.ts). What the page kept stays, for `agentbook webui` to serve again.
async function webuiOff() {
  if (!servesPage(HOME)) return "This machine doesn't serve a page: agentbook webui serves one.";
  await stopDaemon();
  fs.rmSync(DEVICE(), { force: true });
  await startDaemon();
  return machineLogin(HOME) ? "agentbook's page here is off: agentbook-cli sends this machine's threads to your other pages, which steer it with your passkey there. agentbook webui serves the page again, with what it kept." : "agentbook's page here is off. agentbook webui serves it again, with what it kept.";
}
// On nobody's account yet: agentbook-cli serves the first run's page (first-run.ts), whose one button signs in and puts
// this machine on its person's account.
async function firstRunPage(args: string[], { print }: { print: Print }) {
  const server = pageUrl();
  await stopOld(print);
  keepPluginDir();
  if ((await daemon<Status>("GET", "/status"))?.page !== server) {
    if ((await daemon<Status>("GET", "/status"))?.pid) await stopDaemon();
    await stopServer(server, print);
    await startDaemon(["--webui"]);
    for (let i = 0; i < 60 && (await daemon<Status>("GET", "/status"))?.page !== server; i++) await sleep(150);
    if ((await daemon<Status>("GET", "/status"))?.page !== server) throw new Error(`agentbook-cli started, but isn't serving its page at ${server}: see ${CLI_LOG}`);
  }
  if (process.platform === "darwin" && !args.includes("--no-open")) execFile("open", [server], () => {});
  return `agentbook is running at ${server}. This machine isn't on your agentbook account yet: sign in there with Google to add it, or run agentbook login.`;
}
// An agentbook-server running on its own at `server` (bin/agentbook-server, from before agentbook webui): stopped by
// its pid, so this process can take its port. Anything else there is left alone, and said.
async function stopServer(server: string, print: Print) {
  const h = await fetch(`${server}/api/health`, { signal: AbortSignal.timeout(1500) })
    .then(async (r) => (await r.json()) as { server?: boolean } | null)
    .catch(() => null);
  if (!h) return;
  if (!h.server) throw new Error(`Something else answers at ${server}: stop it, then run agentbook webui again.`);
  const port = new URL(server).port || "80";
  const pid = Number(spawnSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" }).stdout.trim().split("\n")[0]);
  if (!pid) throw new Error(`An agentbook-server answers at ${server}, but its process can't be found: stop it, then run agentbook webui again.`);
  print(`Stopping the agentbook-server running on its own (pid ${pid}), to serve its page from agentbook-cli.`);
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 100 && (await fetch(`${server}/api/health`, { signal: AbortSignal.timeout(500) }).catch(() => null)); i++) await sleep(100);
}

// This machine's OpenClaw gateway: how it's reached, pairing with one (a setup code from `openclaw qr
// --setup-code-only`, or its address and token), or forgetting it.
// Agents that run on their vendor's computers (Claude Agent, Devin), connected from this machine: the key comes in on
// stdin (never an argument, which a process list and a shell's history would keep) and doesn't pass through the server.
const REMOTE_USAGE = "usage: agentbook-cli remote [status | connect claude-agent [--budget <dollars>] | connect devin [--org <id>] [--budget <ACUs>] | off claude-agent | off devin]; the key comes in on stdin, with a GitHub token on the next line if Claude Agent is to push";
// The runtimes connected by a key (shared/runtimes.ts, those with a `setup` form), by id.
const KEYED = Object.values(RUNTIMES)
  .filter((r) => r.setup)
  .map((r) => r.id);
async function remoteCommand([sub, vendor, ...args]: string[]) {
  const none = "agentbook-cli isn't running: agentbook-cli up.";
  if (!sub || sub === "status") {
    const r = await daemon<Partial<Record<RuntimeId, RemoteSaid>>>("GET", "/local/remote");
    if (!r) return none;
    return KEYED.filter((k) => r[k]).map((k): [string, RemoteSaid] => [k, r[k]]).map(([k, c]) => `${k}: ${c.connected ? "connected" : "not connected"}${c.org ? ` (organization ${c.org})` : ""}${c.github ? ", with a GitHub token" : ""}${c.budget ? `, $${c.budget} a thread` : ""}${c.error ? `: ${c.error}` : ""}`).join("\n");
  }
  if (!KEYED.includes(vendor as RuntimeId) || !["connect", "off"].includes(sub)) throw new Error(REMOTE_USAGE);
  const send = async (body: object) => {
    const r = await daemon("POST", "/local/remote", body);
    if (!r) throw new Error(none);
    if (r.error) throw new Error(r.error);
    return r;
  };
  if (sub === "off") {
    await send({ vendor, disconnect: true });
    return `Forgot ${vendor}'s key on this machine. Its threads stay on agentbook.`;
  }
  if (process.stdin.isTTY) throw new Error("Pipe its key in, so it stays out of your shell's history: pbpaste | agentbook-cli remote connect " + vendor);
  const opt = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
  // Its key on the first line, and a GitHub token, if there's one, on the second.
  const [key, github_token] = (await new Response(process.stdin).text()).split("\n").map((l) => l.trim());
  if (!key) throw new Error(REMOTE_USAGE);
  await send({ vendor, key, ...(opt("--org") ? { org: opt("--org") } : {}), ...(opt("--budget") ? { budget: opt("--budget") } : {}), ...(github_token ? { github_token } : {}) });
  return `${vendor} is connected on this machine. Start a thread with it from agentbook.`;
}

async function openclawCommand([sub, ...args]: string[]) {
  const say = (c: OpenclawSaid | null) => {
    if (!c) return "agentbook-cli isn't running: agentbook-cli up.";
    if (c.mode !== "gateway") return c.connected ? "OpenClaw: through this machine's openclaw command." : "OpenClaw: not connected. Pair with a gateway: agentbook-cli openclaw pair <setup code> (openclaw qr --setup-code-only, on its machine).";
    if (c.state === "connected") return `OpenClaw: connected to ${c.url}.`;
    if (c.state === "pairing") return `OpenClaw: waiting for you to approve agentbook on ${c.url}: run openclaw devices approve ${c.requestId || "<its request>"} on the gateway's machine, or approve "agentbook" in the OpenClaw app.`;
    return `OpenClaw: ${c.state} with ${c.url}${c.error ? `: ${c.error}` : ""}.`;
  };
  if (!sub || sub === "status") return say(await daemon<OpenclawSaid>("GET", "/local/openclaw"));
  if (sub === "off") {
    const r = await daemon("POST", "/local/openclaw/pair", { disconnect: true });
    if (!r) throw new Error("agentbook-cli isn't running: agentbook-cli up.");
    if (r.error) throw new Error(r.error);
    return "Forgot the OpenClaw gateway (its device key stays, so pairing with it again needs no approval).";
  }
  if (sub !== "pair") throw new Error("usage: agentbook-cli openclaw [pair <setup code> | pair --url wss://… --token <token> | off]");
  const opt = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
  const code = args.find((a, i) => !a.startsWith("--") && !String(args[i - 1] || "").startsWith("--"));
  const body: { setup_code?: string; url?: string; token?: string; password?: string } = code ? { setup_code: code } : { url: opt("--url") || "", ...(opt("--token") ? { token: opt("--token") } : {}), ...(opt("--password") ? { password: opt("--password") } : {}) };
  if (!code && !body.url) throw new Error("usage: agentbook-cli openclaw pair <setup code> | pair --url wss://… --token <token>");
  const r = await daemon<{ connection?: OpenclawSaid }>("POST", "/local/openclaw/pair", body);
  if (!r) throw new Error("agentbook-cli isn't running: agentbook-cli up.");
  if (r.error) throw new Error(r.error);
  // Until it's connected, or waiting for an OK on the gateway, or failed.
  let c: OpenclawSaid | null = r.connection;
  for (let i = 0; i < 40 && !["connected", "pairing", "failed"].includes(c?.state); i++) {
    await sleep(250);
    c = await daemon<OpenclawSaid>("GET", "/local/openclaw");
  }
  return say(c);
}

// Local OS access authorizes one fingerprint. The public key comes from the machine's existing page connection.
async function recoverPasskey(gate: ReturnType<typeof createGate>, args: string[]) {
  const [source, fp] = args;
  if (args.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(source || "") || !/^[A-Za-z0-9_-]{12}$/.test(fp || "")) throw new Error("Copy the recovery command for this passkey from Settings → Passkeys.");
  type RecoverySite = PageKeys & { peer?: string };
  let site: RecoverySite;
  if (source === "primary") {
    const link = saved();
    if (!link?.token) throw new Error("This machine has no direct page login.");
    const url = new URL("/api/cli/passkeys", link.server);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("Recovery needs a secure connection to your page.");
    const response = await fetch(url, { headers: { authorization: `Bearer ${link.token}` }, redirect: "error", signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error("Your page could not confirm this passkey. Check the connection and update agentbook on both machines.");
    const { keys } = await response.json() as Pick<PageKeys, "keys">;
    const local = gate.settings();
    const origin = local.origin || url.origin;
    site = { keys, origin, rp_id: local.rp_id || new URL(origin).hostname };
  } else {
    const found = await daemon<RecoverySite>("POST", "/local/recovery-site", { source }, PORT, 20000);
    if (!found || found.error || !found.peer) throw new Error(found?.error || "Start or update agentbook on this machine and try again.");
    site = found;
  }
  const pin = pinOf(site);
  const match = pin.keys.filter(k => fingerprint(k.spki) === fp);
  if (match.length !== 1) throw new Error("That fingerprint does not identify one registered passkey on this page.");
  const key = match[0];
  const prior = site.peer ? gate.siteOf({ peer: site.peer, url: pin.origin }) : gate.settings();
  if (prior && site.peer && "name" in prior && prior.name && prior.name !== site.peer) throw new Error("The saved page belongs to a different machine.");
  if (prior?.origin && (prior.origin !== pin.origin || prior.rp_id !== pin.rp_id)) throw new Error("This machine trusts a different page for that login.");
  if (prior?.keys.some(k => k.id === key.id && (k.alg !== key.alg || k.spki !== key.spki))) throw new Error("A different key is already registered under this credential ID.");
  if (!prior?.keys.some(k => k.id === key.id)) {
    if (site.peer) {
      const keys = [...(prior?.keys || []), key];
      gate.vouch({ envelope: { site: { ...pin, keys }, name: site.peer, at: new Date().toISOString() } });
    } else gate.importKeys({ ...pin, keys: [key] });
  }
  return `This machine trusts ${key.name || "your passkey"} (${fp}) on ${pin.origin}.
Refresh Passkeys on that page.`;
}

// The gate's commands: share a folder or keep one out, show the settings, OK what waits for an OK here, the log.
async function gateCommand(cmd: string, args: string[]) {
  const gate = createGate({ home: HOME });
  const when = (at: string) => new Date(at).toLocaleString();
  switch (cmd) {
    case "allow":
    case "deny": {
      if (!args.length) throw new Error(`Which folder? agentbook-cli ${cmd} <folder>`);
      return args.map((f) => (cmd === "allow" ? `Shared ${gate.allow(f)}: agentbook can start threads and read files there.` : `Kept out ${gate.deny(f)}: agentbook can't start threads or read files there.`)).join("\n");
    }
    case "gate": {
      const s = gate.settings();
      const d = await daemon<GateInfo>("GET", "/gate");
      const lines = [`This machine is ${s.owner ? `@${s.owner}'s` : d?.owner ? `@${d.owner}'s` : "nobody's yet (it's whoever logs it in)"}.`];
      if (d?.shared) lines.push("It shares:", ...d.shared.map((f) => `  ${f}`));
      else lines.push(`It shares ${s.folders.length ? s.folders.join(", ") : "no folders of its own"}, with its clone folder and the checkouts its agents worked in (start agentbook-cli to see them).`);
      if (s.never.length) lines.push(`It keeps out: ${s.never.join(", ")}`);
      if (s.history_pick === "pending") lines.push("Your agents' past stays here until you pick how much goes up, on the welcome card on top of your feed.");
      else if (s.history_from) lines.push(`Your past stays here: nothing from before ${when(s.history_from)} goes up.`);
      if (s.codex_tools === false) lines.push("Codex's settings stay as they are.");
      const keyLine = keySaid(d);
      if (keyLine) lines.push(keyLine);
      if (s.private_terminals) lines.push("Private terminals is on here: only threads started in agentbook are on it.");
      const off = Object.entries(s.commands).filter(([, on]) => on === false).map(([k]) => k);
      lines.push(off.length ? `Turned off: ${off.join(", ")}` : "Every kind of command is on.", `New threads: at most ${s.starts_per_hour} an hour.`);
      if (s.ask_here.length) lines.push(`Asks here first: ${s.ask_here.join(", ")}`);
      lines.push(`Settings: ${path.join(HOME, "cli", "gate.json")}`);
      return lines.join("\n");
    }
    case "approve": {
      const no = args.includes("--no");
      const cid = args.find((a) => !a.startsWith("--"));
      if (!cid) {
        const d = await daemon<GateInfo>("GET", "/gate");
        if (!d) throw new Error("agentbook-cli isn't running.");
        if (!d.waiting?.length) return "Nothing waits for an OK.";
        return d.waiting.map((w) => `${w.cid}  ${w.kind} from @${w.by}, ${when(w.at)}: ${JSON.stringify(w.args).slice(0, 200)}`).join("\n") + "\n\nagentbook-cli approve <id> to let it run, or add --no to refuse it.";
      }
      const r = await daemon("POST", "/gate/approve", { cid, yes: !no });
      if (!r) throw new Error("agentbook-cli isn't running.");
      if (r.error) throw new Error(r.error);
      return no ? `Refused ${cid}.` : `Let ${cid} run.`;
    }
    case "keys": {
      // The passkeys this machine takes signed commands from.
      const [sub, which] = args;
      if (sub === "recover") return recoverPasskey(gate, args.slice(1));
      if (sub === "export") return JSON.stringify(gate.keys(), null, 2);
      if (sub === "import") {
        if (process.stdin.isTTY) throw new Error("Pipe the keys in, from a machine that has them: agentbook-cli keys export | ssh <machine> agentbook-cli keys import");
        let from;
        try {
          from = JSON.parse(fs.readFileSync(0, "utf8"));
        } catch {
          throw new Error("That isn't what agentbook-cli keys export writes.");
        }
        const added = gate.importKeys(from);
        return `This machine now takes commands signed on ${from.origin} by:\n${added.map((k) => `  ${k.name || "a passkey"} (${fingerprint(k.spki)})`).join("\n")}`;
      }
      if (sub === "remove") {
        if (!which) throw new Error("Which key? agentbook-cli keys remove <fingerprint>");
        gate.removeKey(which);
        return gate.settings().keys.length ? `Removed ${which}.` : `Removed ${which}. This machine keeps no keys now. ${elsewhere(saved()?.server) ? NEEDS_KEYS : UNSIGNED_HERE}`;
      }
      if (sub && sub !== "list") throw new Error("agentbook-cli keys [list | export | import | remove <fingerprint> | recover <source> <fingerprint>]");
      const k = gate.keys();
      // The other pages of yours it takes signatures from, on what comes from their machines (Sign once, as they linked).
      const sites = k.sites.flatMap((x) => [`From ${x.name ? `${x.name}, ` : ""}signed on ${x.origin}, by:`, ...x.keys.map((y) => `  ${y.name || "a passkey"}  ${y.fingerprint}`)]);
      if (!k.keys.length) return [`This machine keeps no passkeys yet. ${elsewhere(saved()?.server) ? NEEDS_KEYS : UNSIGNED_HERE}`, ...sites].join("\n");
      return [`This machine (${k.machine}) takes the commands that can run something only when they're signed on ${k.origin}, by:`, ...k.keys.map((x) => `  ${x.name || "a passkey"}  ${x.fingerprint}  added ${when(x.added)}`), ...sites].join("\n");
    }
    case "log": {
      const lines = gate.audits(Number(args[0]) || 30);
      if (!lines.length) return "Nothing in the log yet.";
      return lines.map((l) => `${when(l.at)}  ${l.outcome.padEnd(8)} ${l.kind}${l.by ? ` from @${l.by}` : ""}${l.post ? ` on ${l.post}` : ""}${l.root || l.path ? ` (${l.root || l.path})` : ""}${l.reason ? `: ${l.reason}` : ""}`).join("\n");
    }
  }
}

// A copy Claude Code started made its thread again: `agentbook-cli fold <copy> <thread>`, by their ids or the start.
async function fold([copy, post]: string[]) {
  if (!copy || !post) throw new Error("usage: agentbook-cli fold <copy> <thread>  (session ids, or the start of them)");
  const r = await daemon<{ copy: string; label: string; post: string; follow?: boolean }>("POST", "/local/fold", { copy, post });
  if (!r) throw new Error("agentbook-cli isn't running: agentbook-cli up.");
  if (r.error) throw new Error(r.error);
  return `Folded ${r.copy} into ${r.label} (${r.post})${r.follow ? "; the thread goes on in the copy" : ""}.`;
}

// Everything it changed outside its folder, undone, and its login revoked. `--purge` removes its folder too, unless
// a server's data is in there (a person's whole agentbook, on the machine that runs it). Claude Code last: that takes
// the folder this runs from, when it's the plugin's.
async function uninstall(args: string[]) {
  // Signed in to an account, it stays so: logging out deletes the account's data here, which is its own step.
  const said = [machineLogin(HOME) ? "It's still on your agentbook: agentbook logout takes it off, and deletes what agentbook keeps for you here." : await logout([], { print: () => {} })];
  await stopDaemon();
  said.push(removeCodexEntry() ? `Took agentbook's tools out of ${codexConfig()}.` : "Codex's settings have nothing of agentbook's.");
  if (args.includes("--purge")) {
    if (fs.existsSync(path.join(HOME, "server"))) said.push(`Kept ${HOME}: it holds an agentbook-server's data too. Remove it yourself if you mean to.`);
    else if (!fs.existsSync(path.join(HOME, "cli"))) said.push(`Nothing to remove at ${HOME}.`);
    else {
      fs.rmSync(HOME, { recursive: true, force: true });
      said.push(`Removed ${HOME}.`);
    }
  } else said.push(`Kept ${HOME}, your local copy of everything it followed: agentbook-cli uninstall --purge removes it.`);
  const claude = (...a: string[]) => spawnSync(process.env.AGENTBOOK_CLAUDE || "claude", a, { encoding: "utf8", timeout: 60000 });
  const gone = claude("plugin", "uninstall", "agentbook@agentbook");
  if (gone.error && "code" in gone.error && gone.error.code === "ENOENT") said.push("Claude Code isn't on this machine's path, so its plugin wasn't touched.");
  else if (gone.status) said.push(`Claude Code didn't remove the plugin: ${(gone.stderr || gone.stdout).trim().split("\n")[0]}`);
  else {
    said.push("Removed the plugin from Claude Code.");
    const market = claude("plugin", "marketplace", "remove", "agentbook");
    if (market.status) said.push(`It kept the marketplace: ${(market.stderr || market.stdout).trim().split("\n")[0]}`);
  }
  if (!installedByClaude()) said.push(`The code is still at ${path.dirname(PLUGIN_ROOT)}: remove that folder too.`);
  said.push("Your threads stay on the server, and folders Claude Code trusts stay trusted.");
  return said.join("\n");
}

// Private terminals on this machine, whatever the server says: only threads started in agentbook are on it.
function privateCommand([to]: string[]) {
  const gate = createGate({ home: HOME });
  if (to === "on" || to === "off") gate.agree({ private_terminals: to === "on" });
  else if (to) throw new Error("usage: agentbook-cli private [on|off]");
  return gate.settings().private_terminals ? "Private terminals is on here: only threads started in agentbook are on it, whatever your profile says." : "Private terminals isn't on here: your profile's setting decides.";
}

const version = () => `agentbook-cli ${VERSION || "(version unknown)"}`;
async function unlink(args: string[]) {
  const [name] = args.filter((a) => !a.startsWith("--"));
  if (!name) throw new Error("usage: agentbook unlink <machine>: one of your machines linked to this one, which it takes off your agentbook");
  const r = await daemon<{ unlinked?: string; told?: boolean }>("POST", "/local/mesh/unlink", { name });
  if (!r) throw new Error("agentbook isn't running on this machine: run agentbook webui, then unlink again.");
  if (r.error) throw new Error(r.error);
  return `Unlinked ${r.unlinked}: it's off your agentbook, so no page of yours shows its new threads or sends it commands now.${r.told ? "" : ` ${r.unlinked}'s page didn't hear (it's off, or can't be reached): it drops your other machines as it next hears from the relay.`}`;
}

const help = () => `${version()}: this machine's half of agentbook. It follows your agents, sends what they do to your
agentbook server, and does what you ask from its page, through its gate.

Getting it on a server:
  agentbook-cli login                    Add this machine to your agentbook: sign in on the relay's page, and say yes
                                         to the code it shows (--name <name>, --no-open, --no-start). With no page
                                         here, it sends its threads to your pages, which steer it
  agentbook-cli logout [--yes]           Take it off your agentbook, and delete everything agentbook keeps for you here
  agentbook-cli login <server>           Log this machine in to a page elsewhere: approve the code it shows there
      --name <name>                      Its name on the server
      --history, --no-history            Send what your agents did before this too, or don't
      --codex-tools, --no-codex-tools    Add agentbook's tools to Codex, or don't
      --private                          Turn on Private terminals
      --no-update                        Don't let it update itself
  agentbook-cli logout                   Revoke its token there, and stop
  agentbook-cli uninstall [--purge]      Log out, stop, and take it out of Codex and Claude Code

Running it:
  agentbook-cli status                   Whether it's running, its server, and what's waiting to go up
  agentbook-cli up, down                 Start or stop the background process
  agentbook-cli webui [--no-open]        agentbook on this machine alone: its page too, from the same process
  agentbook-cli webui off                No page here: its threads go to your other machines' pages
  agentbook-cli unlink <machine>         Take one of your machines off your agentbook: no page of yours gets its threads after
  agentbook-cli run                      The background process, in this terminal
  agentbook-cli update                   Take what main has now
  agentbook-cli update auto|ask|off      Whether it updates by itself (auto, unless you say), and update status

What your server can do here:
  agentbook-cli gate                     What this machine lets its server do
  agentbook-cli allow|deny <folder>      Share a folder, or keep one out
  agentbook-cli approve [id] [--no]      Let through, or refuse, a command waiting for an OK here
  agentbook-cli log [n]                  The last commands it took or refused
  agentbook-cli keys                     The passkeys it accepts: keys export, keys import, keys remove <fingerprint>
  agentbook-cli keys recover <source> <fingerprint>  Approve one registered key here using its command from Settings
  agentbook-cli private [on|off]         Keep what you start in a terminal off agentbook, whatever the server says

Your agents:
  agentbook-cli claude [args]            Claude Code with your messages arriving between turns
  agentbook-cli dev [args]               The same, with the plugin from this folder, not installed
  agentbook-cli openclaw [pair <code> | off]           Pair with an OpenClaw gateway, or forget it
  agentbook-cli remote [connect <kind> | off <kind>]   A cloud agent: claude-agent or devin, its key on stdin
  agentbook-cli fold <copy> <thread>     Make a copy Claude Code started part of its thread again

A shared Linux machine, as root (each person their own Linux user and agentbook-cli):
  agentbook-cli seat add <name> [--machine <name>]   A seat for someone: no sudo, a port of their own
  agentbook-cli seat login <name> <server>           Log their agentbook-cli in as them, for them to approve
  agentbook-cli seat remove <name>                   Stop it, and delete their Linux user and home
  agentbook-cli seat [list]                          Who has a seat, and whether theirs is running

  agentbook-cli help, --version          This, and which version this is

Its log is ${CLI_LOG}.`;

// What can come in place of a command.
export const FLAGS = { "--help": "help", "-h": "help", "--version": "version", "-v": "version" };
export const COMMANDS = ["login", "connect", "logout", "status", "up", "down", "webui", "local", "allow", "deny", "gate", "approve", "log", "keys", "openclaw", "remote", "fold", "private", "seat", "update", "uninstall", "unlink", "help", "version"];
// A command: what to print. `print`: for what it says before it's done (a code to approve).
export async function runCommand([cmd, ...args]: string[], { print = (s) => console.log(s) }: { print?: Print } = {}) {
  switch (cmd) {
    // `connect` too, as the page says it.
    case "login":
    case "connect":
      return login(args, { print });
    case "logout":
      return logout(args, { print });
    case "status":
      return status();
    case "up":
      return (await startDaemon()) ? `agentbook-cli is running, at http://127.0.0.1:${PORT}.` : "agentbook-cli is already running.";
    case "down": {
      const page = (await daemon<Status>("GET", "/status").catch(() => null))?.page;
      return (await stopDaemon()) ? (page ? `Stopped agentbook-cli, and with it agentbook's page at ${page}.` : "Stopped agentbook-cli.") : "agentbook-cli isn't running.";
    }
    case "webui":
    case "local":
      return webui(args, { print });
    case "openclaw":
      return openclawCommand(args);
    case "remote":
      return remoteCommand(args);
    case "fold":
      return fold(args);
    case "private":
      return privateCommand(args);
    case "seat":
      return seatCommand(args);
    case "update":
      return updateCommand(args, { print });
    case "uninstall":
      return uninstall(args);
    case "unlink":
      return unlink(args);
    case "help":
      return help();
    case "version":
      return version();
  }
  if (["allow", "deny", "gate", "approve", "log", "keys"].includes(cmd)) return gateCommand(cmd, args);
  throw new Error(`agentbook-cli doesn't have a ${cmd} command. It has: ${COMMANDS.join(", ")}.`);
}
