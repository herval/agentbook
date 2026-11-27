// OpenClaw agents and their sessions, through OpenClaw's gateway: the OpenClaw runtime. It says what happened as
// events (RuntimeContext.emit), which the threads core makes ops of; what OpenClaw's history says is read by
// messages.ts. agentbook reaches the gateway one of two ways:
//
// - Directly, when it's given a setup code, or the gateway's address and token (on Add agents, or
//   AGENTBOOK_OPENCLAW_URL and AGENTBOOK_OPENCLAW_TOKEN): a WebSocket connection of its own
//   (gateway.ts), approved once on the gateway as a device, whose events update posts right away.
//   Kept in ~/.agentbook/openclaw.json.
// - Otherwise through this machine's `openclaw` command (`openclaw gateway call <method> --params <json>
//   --json`), which knows where its gateway is and how to sign in to it.
//
// - Each OpenClaw agent is a profile ("openclaw-main", named after its identity, with its identity's avatar),
//   and each of its sessions (a session key) a post. Subagents stay off. So do cron runs, as sessions of their own:
//   a cron job is one post, each run adding to it (see threadJob).
// - agentbook lists sessions every few seconds and reads the history of the ones that changed: their messages
//   are the post's conversation, their tool calls its steps. Connected to its gateway, what's added to a
//   session's history comes as it's written too (session.message). An agent on the claude-cli runtime keeps only its
//   replies in OpenClaw; its steps stay in Claude Code's transcript on the gateway's machine.
// - Exec approvals are Allow/Deny on the post, and the agent's questions (its ask_user tool) are polls.
// - Posting on an agent's wall creates a session, which works in the agent's own workspace; writing on a post
//   sends it a message (steering the turn that's running); Stop aborts the turn.
// - An agent's routines are its cron jobs, on its profile, with their runs. OpenClaw keeps one session per job, each
//   run taking it over, so a job's post is what agentbook saw of them: a run that reported something is what the job
//   told its agent and what it answered, and moves the post up the feed. One with nothing to report (NO_REPLY) doesn't
//   show. OpenClaw refuses messages in a job's session, so its post takes none.
// - An agent's skills are the ones its gateway says it can use (skills.status), on its profile, with how often
//   its sessions read each.
// - Its usage limits (limits.ts) are its gateway's: how much of each provider's limits the accounts the gateway
//   signs in to have used (usage.status, operator.read), the same on each of its agents, when a profile asks.
// - Its agents have agentbook's tools (ab_post, ab_ask…) when its gateway has agentbook's plugin for OpenClaw
//   (plugin/openclaw/): each call comes here over agentbook's connection to it, and is answered as its session's
//   post. Not through the openclaw command, which hears none of the gateway's events.

import { textOf } from "../../../shared/text.ts";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ANSWER_WORDS, HOME } from "../../../lib/common.ts";
import { emojiOf, fetchPicture, fromDataUrl, pictureOf } from "../../../shared/pictures.ts";
import { failedRoutines } from "../../../shared/cron.ts";
import { conversationOf, outOfMemory } from "../../../shared/store.ts";
import { RUNTIMES } from "../../../shared/runtimes.ts";
import type { Mode } from "../../../shared/runtimes.ts";
import type { AnswerEvent, AnswerFile, FileEvent, FileRemote, PermissionEvent, Session } from "../../../shared/types.ts";
import { CODE_ROOT } from "../../../shared/bundle.ts";
import { ADMIN, ADMIN_SCOPES, connectGateway, hasAdmin, makeIdentity } from "./gateway.ts";
import type { GatewayState } from "./gateway.ts";
import { addSay, blank, iso, liveOf, short, skillUses, summaryOf, toolTitle } from "../kit/steps.ts";
import { poll } from "../kit/poll.ts";
import type { Poll } from "../kit/poll.ts";
import { going as workerGoing, shown as shownWorkers, stateOf } from "../../workers.ts";
import type { Worker } from "../../workers.ts";
import { limitsReader, openclawLimitsOf } from "../../limits.ts";
import { cronPrompt, fold, forwarded, idOf, joined, keyAgent, MIME, mediaLines, mediaOf, midTurn, once, reported, sentIn, sentOf, seqOf, startsTurn, toolSent, yoursOf } from "./messages.ts";
import type { OcDigest } from "./messages.ts";
import type { MediaOpts, PastSession, Runtime, RuntimeContext, RuntimeRow, SendOpts, SentFile, StartRequest } from "../runtime.ts";

const DAYS = Number(process.env.AGENTBOOK_OPENCLAW_DAYS || 0); // only sessions active in the last DAYS days (0: all of them)
const PAGE = Number(process.env.AGENTBOOK_OPENCLAW_PAGE || 200); // sessions listed per call
const READERS = 4; // histories read at once while catching up with sessions agentbook hasn't read yet
// What OpenClaw keeps in place of a message too big for its history: nothing anyone said.
const OMITTED = /^\[Claude CLI history record omitted/;
const QUIET_MS = 60 * 60e3; // a session idle this long is over, until it's active again
// A cron job's own session, which each run of it takes over, and the job's id. The key a run has of its own
// (":run:<id>") is only in cron.runs, and a webhook's run has a key like this with no job behind it.
const JOB_KEY = /^agent:[^:]+:cron:([^:]+)$/;
const AGENT = "openclaw-"; // agentbook's id for OpenClaw's agent "main" is "openclaw-main"
const CONFIG = () => path.join(HOME, "cli", "openclaw.json"); // { url, token | password | bootstrapToken (and expiresAt), device: { deviceId, publicKey, privateKey, deviceToken } }
// The gateway's events that mean a post may have changed: look again at once.
// A thread's mode (runtimes.ts's Mode) as an OpenClaw session's permission mode.
const PERMISSION_MODES: Record<Mode, string> = { ask: "guarded", auto: "workspace", plan: "read-only", full: "full" };
// What a tool's approval shows of what it was given: the part a person reads (the command, the file, what it looks
// for), else all of it. OpenClaw describes it as the tool's input, as JSON.
function toolInput(request: { detail?: string; description?: string }): string {
  const text = String(request?.detail || request?.description || "");
  try {
    const input = JSON.parse(text);
    const main = ["command", "file_path", "path", "pattern", "url", "skill", "query"].map((k) => input?.[k]).find((v) => typeof v === "string" && v);
    if (main) return main;
  } catch {}
  return text;
}
const EVENTS = new Set(["sessions.changed", "session.message", "session.tool", "chat", "exec.approval.requested", "exec.approval.resolved", "plugin.approval.requested", "plugin.approval.resolved", "question.requested", "question.resolved", "cron", "skills.changed"]);
const CRON_MS = Number(process.env.AGENTBOOK_OPENCLAW_CRON_MS || 30000); // how often its routines are listed
const SKILLS_MS = Number(process.env.AGENTBOOK_OPENCLAW_SKILLS_MS || 30 * 60e3); // how often its agents' skills are listed
// agentbook's plugin for OpenClaw, which gives its agents agentbook's tools: installed on the gateway's machine.
export const PLUGIN_DIR = path.join(CODE_ROOT, "openclaw");

// fn on each of items, n at a time; what it gives, in their order.
async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  const one = async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, one));
  return out;
}

// What a cron job does: an agent's turn with a message, an event with text, a command, or a script.
interface CronPayload {
  kind?: string;
  message?: string;
  text?: string;
  argv?: string[];
  script?: string;
}

// Whether a gateway has agentbook's plugin (see helloTools): its version, and the tools agentbook has that it
// doesn't; or why agentbook couldn't tell (`installed: null`).
interface GatewayTools {
  installed: boolean | null;
  version?: string | null;
  missing?: string[];
  error?: string;
}
// Admin on a gateway, for the Add agents page (see adminOf).
interface AdminInfo {
  state: string;
  error?: string | null;
  requestId?: string;
  at?: string;
}
// How agentbook reaches OpenClaw, for the Add agents page (never the token): through this machine's openclaw
// command ("command": `connected`, or `state` "idle" before it tried), or a gateway it connects to itself
// ("gateway": its address, how it signs in, and how its connection is going).
export interface OpenclawConnection {
  mode: "command" | "gateway";
  state: "idle" | GatewayState["state"];
  error: string | null;
  connected?: boolean;
  url?: string | null;
  fromEnv?: boolean;
  auth?: "token" | "password" | "setup-code" | "device";
  expiresAt?: number;
  requestId?: string | null;
  deviceId?: string | null;
  server?: string | null;
  tools?: GatewayTools | null;
  plugin?: string;
  admin?: AdminInfo | null;
}

// What agentbook keeps of a session while it runs (see session()).
interface Kept {
  updated: number;
  active: boolean;
  running: boolean;
  cursor: string | null;
  seq: number;
  seen: Set<string>;
  posted: Set<string>;
  before: string[];
  upTo: Record<string, number>;
  legacy: boolean;
  digest: OcDigest;
  say: { id: string; text: string; at: string } | null;
  media: ReturnType<typeof mediaOf>;
  held?: { id: string; job: { job: string; name: string; text: string }; at: string } | null;
  loaded: boolean;
}

export function createOpenClaw(): Runtime {
  let ctx: RuntimeContext = null;
  const log = (line: string) => ctx?.log(line);
  const bin = () => process.env.AGENTBOOK_OPENCLAW_BIN || "openclaw";
  const enabled = process.env.AGENTBOOK_OPENCLAW !== "0";
  let connected = false;
  let lastError = null;
  let downSince = null; // since when agentbook can't reach OpenClaw (null while it can, and before it first tried)
  const agents = new Map(); // OpenClaw agent id -> { id, name, workspace, model }
  const sessions = new Map<string, Kept>(); // session key -> what agentbook keeps of it (see session())
  const asked = new Map(); // question request key -> { kind: "approval"|"question", id, qid (an approval's prompt), asks: Map(question id -> OpenClaw's), answers }
  let workers = new Map<string, Worker[]>(); // post key -> the subagents it started, newest first (see noteWorkers)
  const workerSteps = new Map(); // a subagent's session key -> { title, at }: the tool it last started
  const workerN = new Map(); // a subagent's session key -> how many tools it started: its history's, and those heard since
  let agentsAt = 0;
  let defaultAgent = "main"; // the agent a routine without one runs as
  let jobs = null; // its agents' routines (see routineOf), null until listed or when the gateway has none to list
  let jobsAt = 0;
  let skillsAt = 0;
  // Looking at its sessions every few seconds (sync), and longer apart while it can't: 10s after a failure, doubling
  // to 5 minutes (kit/poll.ts).
  let loop: Poll | null = null;
  let gw = null; // the direct connection to a gateway, when one is set
  let gwState: GatewayState | null = null;
  // The owner's connection, with admin (gateway.ts's ADMIN_SCOPES): open while agentbook's device token has
  // it, for what this machine's owner does (their own messages, the threads they start, Run now and Pause), never
  // anyone else's. `gwId`: the device both sign in as, one object, so a token either is handed reaches the other.
  let gwAdmin = null;
  let adminState = null;
  let gwId = null;
  // Admin asked for (askAdmin), until the gateway approves it or it lapses: { requestId, at, status, error }, `status`
  // once it's over without admin ("rejected", "expired", "failed", "lost": the gateway took it back).
  let upgrade = null;
  // Whether that gateway has agentbook's plugin, which gives its agents agentbook's tools (see helloTools): {
  // installed, version, missing: tools agentbook has that this version of it doesn't }, or why agentbook couldn't
  // tell; null until it asked, on this connection.
  let tools: GatewayTools | null = null;
  let soonTimer = null;
  const soon = () => {
    clearTimeout(soonTimer);
    soonTimer = setTimeout(() => void loop?.now(), 250);
  };
  // Its page hears something changed: a thread (`save`: its snapshot is kept and its work sent), or what it shows of
  // OpenClaw (its connection, its agents' workspaces and routines).
  const changed = (thread?: string, save?: boolean) => void ctx?.emit({ e: "changed", thread, save });

  /* ---------- a gateway of its own ---------- */

  function readConfig() {
    try {
      return JSON.parse(fs.readFileSync(CONFIG(), "utf8"));
    } catch {
      return {};
    }
  }
  function writeConfig(c) {
    fs.mkdirSync(HOME, { recursive: true });
    fs.writeFileSync(CONFIG(), JSON.stringify(c, null, 1) + "\n", { mode: 0o600 });
    fs.chmodSync(CONFIG(), 0o600); // the token and the device's key are in it
  }
  function settings() {
    const c = readConfig();
    const env = process.env.AGENTBOOK_OPENCLAW_URL;
    return { url: env || c.url || null, token: (env ? process.env.AGENTBOOK_OPENCLAW_TOKEN : c.token) || undefined, password: (env ? process.env.AGENTBOOK_OPENCLAW_PASSWORD : c.password) || undefined, bootstrapToken: (!env && c.bootstrapToken) || undefined, expiresAt: (!env && c.expiresAt) || null, fromEnv: !!env };
  }

  function saveIdentity(id) {
    // Once the gateway hands agentbook a device token, the setup code's token is spent.
    const { bootstrapToken, expiresAt, ...c } = readConfig();
    writeConfig({ ...(id.deviceToken ? c : { ...c, bootstrapToken, expiresAt }), device: id });
    if (gwAdmin && !hasAdmin(id)) linkAdmin(); // a token without admin: the owner's connection goes
  }

  // Connect to the gateway set, if there is one (and drop the one before).
  function linkGateway() {
    gw?.close();
    gw = null;
    gwState = null;
    gwAdmin?.close();
    gwAdmin = null;
    adminState = null;
    gwId = null;
    upgrade = null;
    commandLists.clear();
    tools = null;
    const s = settings();
    if (!s.url || !enabled) return;
    let identity = readConfig().device;
    if (!identity?.privateKey) {
      identity = makeIdentity();
      writeConfig({ ...readConfig(), device: identity });
    }
    gwId = identity;
    gw = connectGateway({
      url: s.url,
      token: s.token,
      password: s.password,
      bootstrapToken: s.bootstrapToken,
      identity,
      save: saveIdentity,
      onState: (st) => {
        gwState = st;
        if (st.state !== "connected") tools = null;
        if (st.state === "connected") {
          lastError = null;
          soon();
          ctx.refetch(); // the files that stopped coming while it was away
          helloTools();
          if (!gwAdmin && hasAdmin(gwId)) linkAdmin(); // and the owner's again, after one that gave up
        }
        reached(st.state === "connected");
      },
      onEvent: (event, payload) => {
        if (event === "cron") jobsAt = 0; // a routine changed, started or finished
        if (event === "skills.changed") skillsAt = 0;
        if (event === "session.message" && heard(payload)) return;
        if (event === "session.tool") workerStep(payload);
        if (event === "plugin.agentbook.call") answerCall(payload);
        if (EVENTS.has(event)) soon();
      },
      log,
    });
  }

  // The owner's connection, while the device token has admin: no events (the everyday one hears them), and given up
  // on, rather than tried again, when the gateway turns it down. Turned down for its scopes (the token was rotated
  // with less on the gateway, or it wants admin approved again), agentbook stops counting on admin.
  function linkAdmin() {
    gwAdmin?.close();
    gwAdmin = null;
    adminState = null;
    const s = settings();
    // Only as its own device: a gateway's token or password signs in with what that gives.
    if (!gw || !gwId || s.token || s.password || !hasAdmin(gwId)) return;
    const conn = connectGateway({
      url: s.url,
      identity: gwId,
      scopes: ADMIN_SCOPES,
      subscribe: false,
      owners: true,
      save: saveIdentity,
      log,
      // Approvals only it sees (those OpenClaw's own runtime asks for, which only an admin sees): look at once.
      onEvent: (event) => {
        if (/\.approval\.(requested|resolved)$/.test(event)) soon();
      },
      onState: (st) => {
        if (gwAdmin !== conn) return;
        adminState = st;
        if (st.state === "failed") {
          gwAdmin = null;
          if (/SCOPE|PAIRING_REQUIRED|NO_TOKEN/i.test(st.code || "")) {
            gwId.scopes = (gwId.scopes || []).filter((x) => x !== ADMIN);
            saveIdentity(gwId);
            upgrade = { requestId: null, at: Date.now(), status: "lost", error: st.error || null };
            log(`openclaw: the gateway no longer takes agentbook as an admin (${st.error || st.code}), so it goes on without`);
          }
        }
        commandLists.clear();
        changed();
      },
    });
    gwAdmin = conn;
  }
  const adminOn = () => !!gwAdmin && adminState?.state === "connected";
  // What its owner does goes over the owner's connection while it's up; everyone else's, and all of it while it isn't
  // (no admin, or reconnecting), over the everyday one, as it did before admin.
  const ownerCall = (method, params, timeout?: number) => (adminOn() ? gwAdmin.rpc(method, params, timeout) : call(method, params, timeout));

  // Ask the gateway for admin, over the everyday connection (device.scopes.requestUpgrade: OpenClaw 2026.8 and
  // later). Its owner approves it there (`openclaw devices approve <requestId>`, or in OpenClaw's app); the approval
  // doesn't close agentbook's connection, and hands it the new device token on it (waitAdmin).
  async function askAdmin() {
    const s = settings();
    if (!gw) throw Object.assign(new Error("agentbook isn't connected to a gateway of its own: connect it with a setup code first."), { status: 409 });
    if (s.token || s.password) throw Object.assign(new Error("agentbook signs in to this gateway with its token, not as a device of its own: connect it with a setup code to give it admin."), { status: 409 });
    if (hasAdmin(gwId) || (upgrade && !upgrade.status)) return connection(); // has it, or asked and waiting
    let r;
    try {
      r = await call("device.scopes.requestUpgrade", { scopes: ADMIN_SCOPES }, 20000);
    } catch (e) {
      if (/unknown method/i.test(e.message)) throw Object.assign(new Error("This gateway's OpenClaw is older than 2026.8, which can't give a device admin while it's connected: update it first."), { status: 409 });
      throw e;
    }
    if (!r?.requestId) throw new Error("OpenClaw didn't say which request to approve");
    upgrade = { requestId: String(r.requestId), at: Date.now() };
    log(`openclaw: asked the gateway for admin (approve it there: openclaw devices approve ${upgrade.requestId})`);
    waitAdmin(gw, upgrade.requestId);
    changed();
    return connection();
  }
  // Until it's approved, turned down or lapses (the gateway keeps a request 5 minutes). The gateway keeps the request,
  // not the call: one that drops with the connection is made again once it's back.
  async function waitAdmin(conn, requestId) {
    const until = Date.now() + 6 * 60e3;
    const current = () => gw === conn && upgrade?.requestId === requestId && !upgrade.status;
    while (current() && Date.now() < until) {
      let r;
      try {
        r = await conn.rpc("device.scopes.waitUpgrade", { requestId }, Math.max(5000, until - Date.now()));
      } catch (e) {
        if (/closed|not connected|doesn't answer|dropped|didn't answer/i.test(e.message)) {
          await new Promise((ok) => setTimeout(ok, 2000).unref?.());
          continue;
        }
        if (current()) upgrade = { ...upgrade, status: "failed", error: e.message };
        break;
      }
      if (!current()) return;
      if (r?.status === "approved" && r.deviceToken) {
        gwId.deviceToken = r.deviceToken;
        gwId.scopes = Array.isArray(r.scopes) && r.scopes.length ? r.scopes : ADMIN_SCOPES;
        upgrade = null;
        saveIdentity(gwId);
        commandLists.clear();
        log("openclaw: the gateway gave agentbook admin");
        linkAdmin();
      } else upgrade = { ...upgrade, status: r?.status === "expired" ? "expired" : "rejected" };
      break;
    }
    if (current()) upgrade = { ...upgrade, status: "expired" };
    changed();
  }
  // Admin, for the Add agents page: "off", "asked" (with the request to approve), "on", "connecting", or how it ended
  // without ("rejected", "expired", "failed", "lost").
  function adminOf(): AdminInfo | null {
    if (!gw) return null;
    if (hasAdmin(gwId)) return { state: adminOn() ? "on" : adminState?.state === "failed" ? "failed" : "connecting", error: adminState?.state === "failed" ? adminState.error || null : null };
    if (upgrade) return { state: upgrade.status || "asked", requestId: upgrade.requestId, at: new Date(upgrade.at).toISOString(), error: upgrade.error || null };
    return { state: "off" };
  }

  // Set the gateway to connect to (an address, and its token or password, or a setup code's bootstrap token),
  // or none (null).
  function configure(next) {
    const c = readConfig();
    if (!next) {
      writeConfig({ device: c.device }); // keeps the device's key, so approving it again isn't needed for the same gateway
    } else {
      // A new setup code signs in afresh: a device the gateway still knows gets a new device token at once.
      const device = c.device && c.url === next.url && !next.bootstrapToken ? c.device : c.device && { ...c.device, deviceToken: undefined };
      const auth = next.token ? { token: next.token } : next.password ? { password: next.password } : { bootstrapToken: next.bootstrapToken, expiresAt: next.expiresAt || undefined };
      writeConfig({ url: next.url, ...auth, device });
    }
    linkGateway();
    return connection();
  }

  // Whether agentbook can reach OpenClaw: its agents' rows show it as it changes.
  function reached(ok) {
    downSince = ok ? null : downSince || new Date().toISOString();
    changed();
  }
  // And for those rows: { state: "connected" | "connecting" | "pairing" | "failed" | "off", error, since }.
  function link() {
    if (!enabled) return { state: "off", error: null, since: null };
    const c = connection();
    const state = c.state === "idle" ? "connecting" : c.state;
    return state === "connected" ? { state, error: null, since: null } : { state, error: c.error || null, since: downSince };
  }

  // How agentbook reaches OpenClaw, for the Add agents page. Never the token.
  function connection(): OpenclawConnection {
    const s = settings();
    if (!gw) return { mode: "command", connected, error: lastError, state: connected ? "connected" : lastError ? "failed" : "idle" };
    const st = gwState || { state: "connecting" };
    const auth = s.token ? "token" : s.password ? "password" : s.bootstrapToken ? "setup-code" : "device";
    return { mode: "gateway", url: s.url, fromEnv: s.fromEnv, auth, ...(auth === "setup-code" && s.expiresAt ? { expiresAt: s.expiresAt } : {}), state: st.state, error: st.error || null, requestId: st.requestId || null, deviceId: readConfig().device?.deviceId || null, server: st.server || null, tools: st.state === "connected" ? tools : null, plugin: PLUGIN_DIR.replace(os.homedir(), "~"), admin: adminOf() };
  }

  /* ---------- agentbook's tools, for its agents ---------- */

  // agentbook's plugin on the gateway (plugin/openclaw/) hands each call one of its agents makes to agentbook over
  // this connection. Once connected, agentbook says hello to it with the tools it has for the agents it runs, and
  // what to tell them about agentbook: the plugin offers them only while an agentbook that said so is connected.
  async function helloTools() {
    const ask = async (method) => (await ctx.mcpCall({ jsonrpc: "2.0", id: 1, method, params: {} }, { proc: "openclaw:hello" }))?.result;
    try {
      const [init, list] = await Promise.all([ask("initialize"), ask("tools/list")]);
      const offered = (list?.tools || []).map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
      const r = await call("agentbook.hello", { tools: offered, instructions: init?.instructions || "" }, 15000);
      const has = new Set(r?.tools || []);
      tools = { installed: true, version: r?.plugin || null, missing: offered.map((t) => t.name).filter((n) => !has.has(n)) };
      if (tools.missing.length) log(`openclaw: agentbook's plugin on the gateway is ${tools.version}, without ${tools.missing.join(", ")}: install it again from ${PLUGIN_DIR}`);
    } catch (e) {
      tools = /unknown method/i.test(e.message) ? { installed: false } : { installed: null, error: e.message };
    }
    changed();
  }

  // A call one of its agents made, which the plugin rang about: take it (unless another agentbook did), answer it as
  // its session's post, and hand the answer back.
  async function answerCall(p) {
    const id = p?.id && String(p.id);
    if (!id || !gw) return;
    let c;
    try {
      c = await call("agentbook.take", { id }, 15000);
    } catch {
      return;
    }
    const result = await toolCall(id, c).catch((e) => ({ content: [{ type: "text", text: e.message }], isError: true }));
    await call("agentbook.done", { id, result }, 30000).catch((e) => log(`openclaw: couldn't answer ${c.tool}: ${e.message}`));
  }
  async function toolCall(id, c) {
    const key = String(c.sessionKey || "");
    // A session agentbook hasn't listed yet (one just started on Telegram) is a post once it has.
    if (key && !post(key)) await loop?.now();
    if (!post(key)) return { content: [{ type: "text", text: "This session isn't a thread on agentbook, so agentbook's tools have nowhere to write." }], isError: true };
    const r = await ctx.mcpCall({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: c.tool, arguments: c.args || {} } }, { proc: `openclaw:${key}`, cwd: c.cwd || null, disk: gatewayDisk(id, c.home) });
    if (r?.error) return { content: [{ type: "text", text: r.error.message }], isError: true };
    return r?.result || { content: [{ type: "text", text: "agentbook didn't answer." }], isError: true };
  }
  // The files a call names, on the gateway's machine (see localDisk, tools/disk.ts), read through the plugin a piece at
  // a time, while agentbook answers the call. 2 MB a piece, the most the plugin hands over: agentbook connected with
  // Node 22's WebSocket until 0.3.23, and it drops the connection when a compressed message unpacks to 4 MB or more
  // (base64 makes 4 MB of file 5.6).
  const PIECE = 2 << 20;
  const gatewayDisk = (id, home) => ({
    home: home || "/",
    async stat(p) {
      const r = await call("agentbook.read", { id, path: p, length: 0 }, 15000);
      return r?.file ? { size: r.size } : null;
    },
    async read(p) {
      const parts = [];
      for (let at = 0, size = 1; at < size; ) {
        const r = await call("agentbook.read", { id, path: p, offset: at, length: PIECE }, 60000);
        if (!r?.file) throw new Error(`No file at ${p}`);
        const piece = Buffer.from(r.data || "", "base64");
        size = r.size;
        if (!piece.length) break;
        parts.push(piece);
        at += piece.length;
      }
      return Buffer.concat(parts);
    },
  });

  /* ---------- the gateway ---------- */

  function call(method, params = {}, timeout = 30000) {
    if (gw) return gw.rpc(method, params, timeout);
    return new Promise((resolve, reject) =>
      execFile(bin(), ["gateway", "call", method, "--params", JSON.stringify(params), "--json", "--timeout", String(timeout - 2000)], { timeout, maxBuffer: 32 << 20 }, (err, stdout, stderr) => {
        let out = null;
        try {
          out = JSON.parse(String(stdout));
        } catch {}
        if (err) {
          if (err.code === "ENOENT") return reject(new Error("OpenClaw isn't installed here, and no gateway is set to connect to."));
          // The first line says what's wrong (the rest is how to fix it, e.g. which Node to install).
          const why = out?.error?.message || out?.message || String(stderr || err.message).trim().split("\n")[0].replace(/^openclaw:\s*/, "");
          return reject(new Error(why || `openclaw gateway call ${method} failed`));
        }
        resolve(out);
      }),
    );
  }

  // The machine its agents run on, the gateway's: by the name you reach it at ("gpu" for
  // wss://gpu.tail1234.ts.net), or, for an address that's a number or this machine, the name the gateway
  // gives itself.
  let presenceHost = null;
  let presenceAt = 0;
  async function loadPresence() {
    presenceAt = Date.now();
    const list = await call("system-presence", {}, 15000).catch(() => null);
    const self = (Array.isArray(list) ? list : list?.presence || []).find((p) => p?.mode === "gateway" && p.reason === "self") || null;
    presenceHost = self?.host ? String(self.host).split(".")[0] : null;
  }
  function hostName() {
    try {
      const h = gw && new URL(settings().url).hostname;
      if (h && !/^(\d+\.){3}\d+$|^\[|^localhost$/i.test(h)) return h.split(".")[0];
    } catch {}
    return presenceHost;
  }

  const post = (key: string): Session | undefined => ctx.state.sessions[key];
  // What agentbook keeps of a session while it runs. `posted`: the history entries already on the post (by
  // their id in OpenClaw), so a restart, which starts with nothing in memory, never copies them again; `before`,
  // what you wrote on agentbook before agentbook first looked at it this time (it restarted), which OpenClaw's history
  // has too (what you write since is the core's echo); `say`, the agent's latest words in the turn that's running,
  // its reply once the turn is over, and `media`, what that turn's replies held.
  // `seq`: where in its history the last entry agentbook read is (OpenClaw numbers them from 1).
  // `legacy`: a post an earlier agentbook copied without ids, maybe several times over.
  const session = (key: string): Kept => {
    if (!sessions.has(key)) {
      const kept = conversationOf(ctx.state, key);
      const posted = new Set(kept.filter((m) => m.ext).map((m) => m.ext));
      const before = kept.filter((m) => m.from === "human" && m.via === "dash" && !m.ext).map((m) => m.text.trim());
      // `upTo`: when the newest message the post has from the history was said, by who said it (copy()).
      const upTo = {};
      for (const m of kept) if (m.ext && Date.parse(m.at) > (upTo[m.from] || 0)) upTo[m.from] = Date.parse(m.at);
      sessions.set(key, { updated: 0, active: false, running: false, cursor: null, seq: 0, seen: new Set(), posted, before, upTo, legacy: !posted.size && kept.some(copied), digest: blank(), say: null, media: [], loaded: false });
    }
    return sessions.get(key);
  };
  // Whether what its history has as yours is what you sent it from agentbook (so it's on the thread already): the
  // core's echo of what was sent since agentbook started, or one from before (`before`). Asked before its files are
  // made, which an echo doesn't get.
  function sentHere(key: string, text: string) {
    if (ctx.echoed(key, text)) return true;
    const se = session(key);
    const i = se.before.indexOf(text);
    if (i < 0) return false;
    se.before.splice(i, 1);
    return true;
  }
  // A message copied from OpenClaw's history before its id was kept: not yours from agentbook, nor agentbook's own word.
  const copied = (m) => !m.ext && !(m.from === "human" && m.via === "dash") && !(m.from === "agent" && /^agentbook /.test(m.text));
  const agentId = (id) => `${AGENT}${id}`;
  const agentName = (id) => agents.get(id)?.name || id;

  async function loadAgents() {
    const r = await call("agents.list");
    const listed = (r?.agents || []).filter((a) => a.kind !== "system");
    defaultAgent = r?.defaultId || "main";
    for (const a of listed) {
      const one = { id: a.id, name: a.identity?.name || a.name || a.id, workspace: a.workspace || "", model: a.model?.primary || (typeof a.model === "string" ? a.model : null) };
      agents.set(a.id, one);
      // Where it runs (the gateway's machine), so every machine that reaches it knows it by one id (server/relay.ts).
      const where = hostName();
      ctx.emit({ e: "agent", agent: agentId(a.id), name: one.name, kind: "openclaw", ...(where ? { host: where } : {}) });
    }
    agentsAt = Date.now();
    lastListed = listed;
    loadAvatars(listed);
  }

  // Each agent's avatar as OpenClaw has it, its identity's picture or emoji (from its config or IDENTITY.md),
  // is the one its profile shows until you set another. A picture comes as a data: URL (a file in its
  // workspace) or a web address, and is saved here only when it changed: `src` says what it came from.
  let avatarsBusy = null;
  let avatarsAgain = false;
  let lastListed = [];
  function loadAvatars(list) {
    // Asked again while a pass runs (its CLI reached its server mid-pass, so a picture that pass couldn't send can go
    // now): another pass follows it, with the agents as last listed. Joining the running one lost that, and the
    // picture waited for the next listing, minutes later.
    if (avatarsBusy) return void (avatarsAgain = true);
    avatarsBusy = (async () => {
      for (const a of list) {
        const id = await call("agent.identity.get", { agentId: a.id }, 15000).catch(() => null);
        const picture = [id?.avatar, a.identity?.avatarUrl, a.identity?.avatar].find((v) => typeof v === "string" && /^(https?:\/\/|data:image\/)/i.test(v));
        // Without one, OpenClaw's avatar is its default, "A".
        const emoji = emojiOf(id?.emoji) || emojiOf(a.identity?.emoji) || (id?.avatar !== "A" ? emojiOf(id?.avatar) : null);
        const src = picture ? crypto.createHash("sha256").update(picture).digest("hex").slice(0, 16) : emoji || "";
        const known = ctx.state.agents[agentId(a.id)]?.avatar_default || null;
        if ((known?.src || "") === src) continue;
        let avatar = null;
        if (picture) {
          const buf = picture.startsWith("data:") ? fromDataUrl(picture) : await fetchPicture(picture);
          // Its bytes go to the server, which shows it.
          try {
            const pic = buf && pictureOf(buf);
            const blob = pic && (await ctx.blobPut(buf, pic.type));
            avatar = pic && blob ? { ...pic, blob, src } : null;
          } catch {}
        }
        // A picture it couldn't get is tried again next time, with the emoji meanwhile.
        if (!avatar && emoji) avatar = { emoji, src: picture ? "" : src };
        if (JSON.stringify(avatar) === JSON.stringify(known)) continue;
        ctx.emit({ e: "fact", op: { t: "agent.avatar", agent: agentId(a.id), default: true, avatar } });
      }
    })()
      .catch((e) => log(`OpenClaw: couldn't get its agents' avatars: ${e.message}`))
      .finally(() => {
        avatarsBusy = null;
        if (avatarsAgain) {
          avatarsAgain = false;
          loadAvatars(lastListed);
        }
      });
  }

  /* ---------- its commands ---------- */

  // What a session can run with a slash command, as its gateway lists them for its
  // agent (commands.list): OpenClaw's own and one for each skill it can use, with what each takes. A command comes in
  // through chat.send as one typed in Telegram does. Left out (`off`, with why): what agentbook's operator scopes
  // can't run (only an admin's or the gateway owner's may), what means nothing here, and what agentbook does itself.
  const NOT_HERE = {
    new: "starts over, which OpenClaw lets only an admin do from outside: give agentbook admin in this machine’s OpenClaw setup on the Agents tab, or start a new thread on its wall",
    reset: "starts over, which OpenClaw lets only an admin do from outside: give agentbook admin in this machine’s OpenClaw setup on the Agents tab, or start a new thread on its wall",
    stop: "is Stop, on the live line",
    btw: "answers on the side, which agentbook doesn't show yet",
    restart: "restarts the gateway, which only its owner may",
    update: "updates OpenClaw, which only the gateway's owner may",
    config: "changes the gateway's settings, which only its owner may",
    debug: "is the gateway owner's",
    mcp: "changes the gateway's MCP servers, which only its owner may",
    plugins: "changes the gateway's plugins, which only an admin may",
    acp: "is an admin's",
    allowlist: "changes who may use it, which only an admin may",
    send: "is the gateway owner's",
    diagnostics: "is the gateway owner's",
    activation: "is the gateway owner's",
    loop: "is the gateway owner's",
    "export-session": "is the gateway owner's",
    "export-trajectory": "is the gateway owner's",
    bash: "runs a shell on the gateway, which only its owner may",
    login: "signs in in a terminal",
    openclaw: "sets OpenClaw up, in a terminal",
    tts: "speaks its replies, which agentbook doesn't play",
  };
  // What admin lets its owner run after all (nobody else sends this machine anything).
  const WITH_ADMIN = new Set(["new", "reset"]);
  const notHere = (name) => (WITH_ADMIN.has(name) && adminOn() ? null : NOT_HERE[name]);
  const commandLists = new Map(); // OpenClaw agent id -> { at, list, off }
  const COMMANDS_MS = 5 * 60e3;
  async function commands(s) {
    const a = keyAgent(s.session_id || s.id);
    const have = commandLists.get(a);
    if (have && Date.now() - have.at < COMMANDS_MS) return { list: have.list, off: have.off };
    const r = await call("commands.list", { agentId: a, sessionKey: s.session_id || s.id, scope: "text", includeArgs: true }, 20000);
    // Its name as typed (the gateway gives it without the slash), and what it takes: each argument, or its choices.
    const nameOf = (c) => String(c.name || "").replace(/^\//, "");
    const what = (x) => (x.choices?.length ? x.choices.map((o) => o?.value ?? o).join("|") : x.name);
    const hintOf = (args) => (Array.isArray(args) ? args : []).map((x) => (x.required ? `<${what(x)}>` : `[${what(x)}]`)).join(" ");
    const rows = (Array.isArray(r?.commands) ? r.commands : []).filter((c) => nameOf(c));
    const list = rows
      .filter((c) => !notHere(nameOf(c)))
      .map((c) => {
        const args = Array.isArray(c.args) ? c.args : [];
        return { name: nameOf(c), hint: hintOf(args), description: short(c.description, 200), from: c.source === "skill" ? "skill" : c.source === "plugin" ? "plugin" : "built-in", takes: args.some((x) => x.required) ? "req" : c.acceptsArgs || args.length ? "opt" : "" };
      });
    const off = rows.filter((c) => notHere(nameOf(c))).map((c) => ({ name: nameOf(c), why: notHere(nameOf(c)) }));
    commandLists.set(a, { at: Date.now(), list, off });
    return { list, off };
  }

  /* ---------- its agents' skills ---------- */

  // The skills each agent can use, as its gateway lists them (OpenClaw's own, those installed for all its
  // agents, and its workspace's), less those turned off, missing what they need, or not allowed for it. They
  // go on its newest post when they change, as Claude Code's do on each of its sessions, and a profile shows
  // what its posts list; an agent's first post gets them as it's made (`skillsDue`).
  const skillLists = new Map(); // OpenClaw agent id -> the skills it can use, as last listed
  let skillsDue = false;
  async function loadSkills() {
    skillsAt = Date.now();
    for (const a of agents.keys()) {
      const r = await call("skills.status", { agentId: a }, 30000).catch((e) => log(`OpenClaw: couldn't list ${agentName(a)}'s skills: ${e.message}`));
      if (Array.isArray(r?.skills)) skillLists.set(a, r.skills.filter((k) => k?.name && k.eligible !== false && !k.disabled && !k.blockedByAgentFilter).map((k) => ({ name: k.name, description: short(k.description, 200), file: k.filePath || null })));
    }
    noteSkills();
  }
  function noteSkills() {
    skillsDue = false;
    const newest = new Map(); // agentbook agent id -> its newest post, and its newest that lists skills
    for (const s of Object.values(ctx.state.sessions)) {
      if (!s.agent?.startsWith(AGENT)) continue;
      const n = newest.get(s.agent) || {};
      if (!n.post || s.started > n.post.started) n.post = s;
      if (s.skills && (!n.listed || s.started > n.listed.started)) n.listed = s;
      newest.set(s.agent, n);
    }
    for (const [a, list] of skillLists) {
      const n = newest.get(agentId(a));
      if (n?.post && JSON.stringify(n.listed?.skills || null) !== JSON.stringify(list)) ctx.emit({ e: "fact", op: { t: "session.skills", post: n.post.id, skills: list } });
    }
  }
  // A skill's SKILL.md, when it's in the agent's workspace (a skill of its own). OpenClaw's, and those
  // installed for all its agents, are elsewhere on the gateway's machine, which it doesn't hand over: null.
  async function skillFile(id, file) {
    const root = agents.get(id.slice(AGENT.length))?.workspace;
    const rel = root && file ? path.posix.relative(root, file) : "";
    if (!rel || rel.startsWith("..") || path.posix.isAbsolute(rel)) return null;
    const f = await workspaceFile(id, rel).catch(() => null);
    return typeof f?.text === "string" ? f.text : null;
  }

  /* ---------- sessions become posts ---------- */

  // The cron job a post is the thread of: one of the jobs you made, not OpenClaw's own upkeep.
  const threadJob = (key) => {
    const id = JOB_KEY.exec(key)?.[1];
    return (id && jobs?.find((j) => j.id === id && !j.builtin)) || null;
  };
  // Sessions people have with an agent, and its cron jobs': not subagents', and no other cron session.
  const shown = (row) => row?.key && !row.spawnedBy && !row.subagentRole && (!/:cron:/.test(row.key) || !!threadJob(row.key));

  // When a session began, as OpenClaw has it: created, or (for an agent's main session, which doesn't say)
  // when its place on the gateway was made. Never when agentbook first saw it.
  const startOf = (row) => iso(row.createdAt) || iso(row.placement?.createdAtMs) || null;
  // A post learns its session began earlier than it thought (its history goes further back).
  function began(key, at) {
    const s = post(key);
    if (s && at && at < s.started) ctx.emit({ e: "fact", op: { t: "session.snapshot", post: key, started: at } });
  }

  function ensurePost(row, { lid, prompt }: { lid?: string; prompt?: string } = {}) {
    const key = row.key;
    const se = session(key);
    const job = threadJob(key);
    if (job) se.digest.ai_title = short(job.name, 120);
    else if (row.derivedTitle || row.displayName || row.label) se.digest.ai_title = short(row.label || row.displayName || row.derivedTitle, 120);
    if (row.model) se.digest.model = row.model;
    if (post(key) && !lid) {
      began(key, startOf(row));
      return post(key);
    }
    const a = keyAgent(key) === row.agentId || !row.agentId ? keyAgent(key) : row.agentId;
    // Its agent's own workspace, on the gateway's machine: no git facts from this one.
    ctx.emit({
      e: "thread",
      thread: key,
      proc: `openclaw:${key}`,
      agent: agentId(a),
      agent_name: agentName(a),
      kind: "openclaw",
      label: ctx.label(key),
      cwd: row.cwd || agents.get(a)?.workspace || "",
      root: "",
      repo: "",
      branch: "",
      host: hostName() || undefined,
      launch: lid,
      started: startOf(row) || iso(row.updatedAt || row.lastActivityAt) || undefined,
      updated: iso(row.updatedAt || row.lastActivityAt) || undefined,
      prompt: prompt ? short(prompt, 2000) : undefined,
    });
    if (ctx.keptOff(key)) return null; // kept off agentbook (Private terminals)
    changed(key, true);
    skillsDue = true;
    return post(key);
  }

  // A session that's running (or just was) is working: its turn began (the core brings back one that was done). Once
  // it stops, what the agent said last is its reply, and the turn is over. One that's quiet for an hour is over until
  // it's active again.
  function setActive(key, active, updatedMs?: number) {
    const s = post(key);
    const se = session(key);
    if (!s) return;
    if (active) ctx.emit({ e: "turn.start", thread: key });
    else if (se.active || s.busy) {
      reply(key);
      ctx.emit({ e: "turn.end", thread: key });
    } else if (s.state !== "done" && updatedMs && Date.now() - updatedMs > QUIET_MS && !(workers.get(key) || []).some(workerGoing)) {
      ctx.emit({ e: "gone", thread: key, reason: "Quiet", ended: iso(updatedMs) });
    }
    se.active = active;
  }

  /* ---------- the subagents a session starts ---------- */

  // A session's agent can hand work to subagents (sessions_spawn), which run as sessions of their own and stay off
  // agentbook as threads. Each is a worker (workers.ts) of the thread that started it (or that started the one that
  // did), with the tool it last started, which the gateway's session.tool events say.
  // A row's state: running while it has a run, else what OpenClaw says of its last one (done when it doesn't say).
  const workerState = (row) => (row.hasActiveRun ? "running" : stateOf(row.status) || "done");
  function noteWorkers(rows) {
    const byKey = new Map(rows.map((r) => [r.key, r]));
    const starter = (row) => row?.spawnedBy || row?.controlOwnerSessionKey || null;
    const next = new Map<string, Worker[]>();
    const kept = new Set();
    for (const row of rows) {
      if (shown(row) || !(row.spawnedBy || row.subagentRole)) continue;
      // The thread it's on: the post up its line of starters (a subagent can start its own).
      let parent = starter(row);
      for (let n = 0; parent && !post(parent) && n < 8; n++) parent = starter(byKey.get(parent));
      if (!parent || !post(parent)) continue;
      const state = workerState(row);
      const ended = workerGoing({ state }) ? null : iso(row.endedAt) || iso(row.lastActivityAt || row.updatedAt);
      const failed = state === "failed" || state === "timed out" || state === "stopped";
      const w = { id: row.key, title: short(row.label || row.derivedTitle || row.displayName || "A subagent", 120), state, started: iso(row.startedAt) || startOf(row), ended, error: failed && row.lastRunError ? short(String(row.lastRunError), 300) : null } as Worker;
      kept.add(row.key);
      (next.get(parent) || next.set(parent, []).get(parent)).push(w);
    }
    for (const [key, list] of next) {
      next.set(key, shownWorkers(list));
      // One that went quiet while its workers went on is going again: the hello it had, so it's open again.
      if (post(key).state === "done" && list.some(workerGoing)) ctx.emit({ e: "thread", thread: key });
    }
    // A step heard before its worker was listed (one started since the list was asked for) waits a while for it.
    for (const [key, st] of workerSteps) if (!kept.has(key) && Date.now() - Date.parse(st.at) > 5 * 60e3) workerSteps.delete(key);
    for (const key of workerN.keys()) if (!kept.has(key) && !workerSteps.has(key)) workerN.delete(key);
    workers = next;
  }
  // The tool a subagent just started (a session.tool event), as its step says it.
  function workerStep(p) {
    const d = p?.data;
    if (!p?.sessionKey || post(p.sessionKey) || d?.phase !== "start" || !d.name) return;
    if (!p.spawnedBy && !workerSteps.has(p.sessionKey)) return;
    workerSteps.set(p.sessionKey, { title: toolTitle(d.name, d.args), at: new Date().toISOString() });
    workerN.set(p.sessionKey, (workerN.get(p.sessionKey) || 0) + 1);
  }
  const workersOf = (key) => (workers.get(key) || []).map((w) => ({ ...w, step: workerSteps.get(w.id) || null, n: workerN.get(w.id) || 0 }));
  // A worker's steps, from its own session's history, as a run's are (routineRun): read when you open it on its
  // thread's page, and again as it starts another tool. Its latest WORKER_STEPS; none (`gone`) once OpenClaw has let
  // go of its history.
  const WORKER_STEPS = 40;
  async function workerStepsOf(key, worker) {
    if (!(workers.get(key) || []).some((w) => w.id === worker)) return null;
    const r = await call("chat.history", { sessionKey: worker, limit: 200 });
    const d = blank();
    const messages = r?.messages || [];
    for (const entry of messages) {
      const m = entry?.message || entry;
      if (!m?.role) continue;
      if (startsTurn(m)) d.turn++;
      fold(d, m, entry.id || m.id || `${m.role}:${m.timestamp}`, iso(m.timestamp || entry.timestamp), agents.get(keyAgent(worker))?.workspace);
    }
    const n = d.steps.filter((x) => x.kind === "tool").length;
    if (n > (workerN.get(worker) || 0)) workerN.set(worker, n);
    return { steps: d.steps.slice(-WORKER_STEPS).map(({ id, kind, at, tool, title, text, done, error }) => ({ id, kind, at, tool, title, text, done, error })), n, gone: !messages.length };
  }

  // Read a session's history and copy onto the post what isn't there yet: your messages, and the agent's
  // reply to each, once its turn is over, each at the time it was said. Its steps come from it too.
  async function readHistory(key) {
    const se = session(key);
    const ask = (more) => call("chat.history", { sessionKey: key, limit: 200, ...more });
    let r = await ask(se.cursor ? { cursor: se.cursor } : {});
    if (r?.kind === "reset") {
      se.cursor = null;
      r = await ask({});
    }
    let entries = r?.messages || [];
    // Without a cursor, the history comes back a page at a time, the latest first. A post that has some of it
    // already (agentbook restarted, or was away for more than a page of it) reads back to what it has, so
    // nothing in between is lost. Its digest is of all of it (`whole`) when that reached its first page.
    if (!se.cursor) {
      let page = r;
      if (se.posted.size) {
        const has = (entry) => se.posted.has(idOf(entry)) || se.posted.has(`${idOf(entry)}:say`);
        for (let n = 0; page?.hasMore && page.nextOffset != null && !entries.some(has) && n < 10; n++) {
          page = await ask({ offset: page.nextOffset });
          entries = [...(page?.messages || []), ...entries];
        }
      }
      if (!se.seen.size) se.digest.whole = !page?.hasMore;
    }
    if (se.legacy) {
      // Those copies go, and the history is copied again, this time once.
      se.legacy = false;
      const drop = conversationOf(ctx.state, key).filter(copied).map((m) => m.id);
      if (drop.length) ctx.emit({ e: "fact", op: { t: "message.drop", post: key, mids: drop } });
    }
    for (const entry of entries) take(key, entry);
    if (entries.length && seqOf(entries.at(-1))) se.seq = seqOf(entries.at(-1));
    const last = entries.at(-1);
    if (!r?.inFlightRun && !se.running && !midTurn(last?.message || last)) reply(key);
    if (r?.deltaCursor) se.cursor = r.deltaCursor;
    const first = entries.map((x) => x?.message || x).find((m) => m?.timestamp);
    if (first) began(key, iso(first.timestamp));
    se.loaded = true;
    took(key);
    return r;
  }
  // The skills it used are on its post at once, not only once a turn ends while agentbook watches.
  function took(key) {
    const used = skillUses(session(key).digest, post(key));
    if (used.changed) ctx.emit({ e: "fact", op: { t: "session.snapshot", post: key, skill_uses: used.uses } });
    changed(key);
  }

  // An entry the gateway says was just added to a session's history (session.message, which it sends agentbook
  // for the sessions it follows): on the post at once, as Discord gets the agent's words while it works, rather
  // than once agentbook reads the history again, which a busy gateway can take minutes to answer. Only the next
  // entry agentbook expects, by its place in the history, so none before it is missed and the post keeps its
  // order (the first of a new session is one), and only one with its id there, so reading it again later
  // doesn't copy it twice; any other comes with the rest of the history. Whether it took it.
  function heard(p) {
    const key = p?.sessionKey;
    const m = p?.message;
    const seq = seqOf(m) || Number(p?.messageSeq) || 0;
    if (!m?.role || !post(key) || !(m.id || m.__openclaw?.id) || !seq) return false;
    if (JOB_KEY.test(key)) return false; // each run starts counting again: its history says what's new
    if (joined(m)) return false; // what it follows comes only from reading the history
    const se = session(key);
    if (seq !== se.seq + 1) return false;
    if (seq === 1 && !se.seen.size) se.digest.whole = se.loaded = true; // all there is of it
    take(key, m);
    se.seq = seq;
    took(key);
    return true;
  }

  const OUTBOUND_KEPT_MS = 24 * 3600e3; // OpenClaw's OUTBOUND_STAGING_TTL_MS
  // Copy a history entry onto the post, once, with its media as files. One copied before agentbook kept its
  // media gets them now. A file comes from OpenClaw when it's first opened, or at once when the message is new,
  // or said less than a day ago: OpenClaw deletes what its agents send (media/outbound) a day after, so one
  // read after a restart, or added to a message agentbook already had, would be gone by the time it's opened.
  function copy(key, ext, m, media = []) {
    const se = session(key);
    const young = Date.now() - Date.parse(m.when) < OUTBOUND_KEPT_MS;
    if (se.posted.has(ext)) {
      const had = media.length && conversationOf(ctx.state, key).find((x) => x.ext === ext);
      if (!had || had.files?.length) return;
      const files = keep(key, ext, media, m.from);
      ctx.emit({ e: "fact", op: { t: "message.files", post: key, ext, files } });
      if (young) for (const fid of files) ctx.fetchFile(fid);
      return;
    }
    se.posted.add(ext);
    // agentbook's first read of it since it started adds only what's newer than what the post already has from the
    // history, by who said it. What's older was copied, or left out, by the rules agentbook had then (a turn's last
    // words, what it sent OpenClaw itself), and reading it again by today's would add messages to turns long over.
    if (!se.loaded && Date.parse(m.when) < (se.upTo[m.from] || 0)) return;
    const files = keep(key, ext, media, m.from);
    ctx.emit({ e: "message", thread: key, ext, ...m, files });
    if (se.loaded || young) for (const fid of files) ctx.fetchFile(fid);
  }
  // A message's media, as files on its post that say where in OpenClaw they are.
  function keep(key, ext, media, from): string[] {
    return media
      .map((x, i) => {
        const stored = `openclaw-${crypto.createHash("sha256").update(`${key}\0${ext}\0${i}`).digest("hex").slice(0, 16)}-${x.name}`;
        const made = ctx.emit({ e: "fact", op: { t: "file.add", from, name: x.name, title: x.name, size: x.size, stored, remote: x.ref } });
        return made ? made.fid : null;
      })
      .filter(Boolean);
  }
  // The turn is over: what the agent said last is its reply, with what its replies held.
  function reply(key) {
    const se = session(key);
    // What a cron job said goes on the post with what its agent answered, from its routine rather than from you. A
    // session it started has no other name.
    if (se.say && se.held) {
      const { id, job, at } = se.held;
      se.held = null;
      if (!post(key)?.ai_title) ctx.emit({ e: "fact", op: { t: "session.snapshot", post: key, ai_title: (se.digest.ai_title ||= short(job.name, 120)) } });
      copy(key, id, { from: "human", via: "routine", text: job.text, routine: { id: job.job, name: short(job.name, 200), why: "cron" }, when: at });
    }
    if (se.say) copy(key, se.say.id, { from: "agent", via: "dash", text: se.say.text, when: se.say.at }, once(se.media));
    se.say = null;
    se.media = [];
  }

  // Fold one history entry into the post: what you and the agent said, the tools it used.
  function take(key, entry) {
    const m = entry?.message || entry;
    if (!m?.role) return;
    const se = session(key);
    const d = se.digest;
    const id = idOf(entry);
    if (se.seen.has(id)) return;
    se.seen.add(id);
    const at = iso(m.timestamp || entry.timestamp) || new Date().toISOString();
    const seq = (entry.__openclaw || m.__openclaw)?.seq;
    if (startsTurn(m)) {
      reply(key); // the turn before it is over
      se.held = null; // a cron run's prompt, if it had nothing to report
      d.turn++;
      const cron = m.provenance?.sourceTool === "cron" && m.provenance.sourcePromptPrefix;
      const text = cron ? `${cron} ${textOf(m.content)}` : forwarded(m) ? null : yoursOf(textOf(m.content), m.provenance);
      if (text === null) return; // OpenClaw's own, to its agent
      const job = cronPrompt(text);
      if (job) return void (se.held = { id, job, at }); // until its run has something to say: reply()
      const media = mediaOf(m, seq);
      if (sentHere(key, text)) return;
      if (ANSWER_WORDS.test(text)) return; // agentbook's, sent before it last started, or by its plugin on the gateway
      if ((text && !OMITTED.test(text)) || media.length) copy(key, id, { from: "human", via: m.__openclaw?.transport?.channel || "terminal", text: OMITTED.test(text) ? "" : text, when: at }, media);
    } else if (m.role === "custom" && m.customType === "run-failed-before-reply") {
      // A turn that failed before the agent said anything ("This turn ended before a reply: All models failed…"):
      // OpenClaw shows that in its place, and so does its post, rather than going quiet.
      const text = textOf(m.content);
      if (!text.trim()) return;
      addSay(d, { id: `${id}:say`, at, text });
      se.say = { id: `${id}:say`, text, at };
    } else {
      const said = fold(d, m, id, at, post(key)?.cwd);
      const media = m.role === "assistant" ? [...mediaOf(m, seq), ...sentOf([...sentIn(m), ...toolSent(m, key)], seq)] : [];
      se.media.push(...media);
      if (joined(m) && !said) {
        // A turn agentbook copied before it told these apart keeps the reply it was given.
        if (se.posted.has(`${id}:say`)) Object.assign(se, { say: null, media: [] });
        return;
      }
      // A reply that's only a picture (or a video, a sound, a file) is a reply too.
      if (said) se.say = { id: `${id}:say`, text: said, at };
      else if (media.length && !se.say) se.say = { id: `${id}:say`, text: "", at };
    }
  }

  // Sessions whose history agentbook hasn't read yet (new to it, or since it started), read a few at a time,
  // the most recently active first. Their posts show they're syncing meanwhile.
  const waiting = [];
  const reading = new Set();
  function catchUp(key) {
    if (waiting.includes(key) || reading.has(key)) return;
    waiting.push(key);
    pump();
  }
  function pump() {
    while (reading.size < READERS && waiting.length) {
      const key = waiting.shift();
      reading.add(key);
      readHistory(key)
        .catch((e) => log(`openclaw history ${key}: ${e.message}`))
        .finally(() => {
          reading.delete(key);
          changed(key);
          pump();
        });
    }
  }

  /* ---------- approvals and questions ---------- */

  // What OpenClaw is waiting on you for in agentbook's threads, each a prompt on its post: commands to allow
  // (exec.approval), its tools to allow (plugin.approval: Read, Skill… on a Claude CLI backend, each asked by
  // OpenClaw's own runtime), and its agents' questions. Approvals are listed and answered over the owner's connection
  // while it's up: OpenClaw shows those its runtime asks for only to a connection with admin (or the device that
  // started the run), and answers only for what a connection sees. A subagent's goes on the thread it works for.
  // One on no thread here (a routine's run before its thread starts, a session kept off agentbook) is left to OpenClaw:
  // it waits for another of its clients, or until it times out (askFallback).
  const askOn = (key) => {
    if (!key) return null;
    if (post(key)) return { thread: key, who: agentName(keyAgent(key)) };
    for (const [thread, list] of workers) {
      const w = list.find((x) => x.id === key);
      if (w) return { thread, who: `Its subagent “${w.title}”` };
    }
    return null;
  };
  async function syncAsks() {
    // null: OpenClaw couldn't say what's open, so nothing is taken as answered.
    const approvals = await ownerCall("exec.approval.list", {}).catch(() => null);
    const live = new Set();
    for (const ap of Array.isArray(approvals) ? approvals : approvals?.approvals || []) {
      const on = askOn(ap.request?.sessionKey);
      const rk = `oc-ap:${ap.id}`;
      live.add(rk);
      if (!on || asked.has(rk)) continue;
      const r = { kind: "approval", id: ap.id, qid: null };
      asked.set(rk, r);
      const cmd = ap.request.command || (ap.request.commandArgv || []).join(" ");
      const where = ap.request.cwd ? `in ${ap.request.cwd}` : "";
      const detail = on.thread === ap.request.sessionKey ? (where ? `In ${ap.request.cwd}` : `${on.who} wants to run a command.`) : `${on.who} wants to run a command${where ? ` ${where}` : ""}.`;
      const made = ctx.emit({ e: "ask", thread: on.thread, kind: "permission", request_id: rk, title: "Allow this command?", tool_name: "Exec", detail, preview: cmd });
      if (made) r.qid = made.qid;
    }
    // A gateway from before plugin approvals answers with an error: none, and none taken as answered.
    const toolAsks = await ownerCall("plugin.approval.list", {}).catch(() => null);
    for (const ap of Array.isArray(toolAsks) ? toolAsks : toolAsks?.approvals || []) {
      const on = askOn(ap.request?.sessionKey);
      const rk = `oc-pa:${ap.id}`;
      live.add(rk);
      if (!on || asked.has(rk)) continue;
      const r = { kind: "tool", id: ap.id, qid: null };
      asked.set(rk, r);
      const tool = ap.request.toolName || "a tool";
      const made = ctx.emit({ e: "ask", thread: on.thread, kind: "permission", request_id: rk, title: tool === "Bash" ? "Allow this command?" : `Allow ${tool}?`, tool_name: ap.request.toolName || "Tool", detail: `${on.who} wants to use ${tool}.`, preview: toolInput(ap.request) });
      if (made) r.qid = made.qid;
    }
    const qs = await call("question.list").catch(() => null);
    for (const q of qs?.questions || []) {
      const rk = `oc-q:${q.id}`;
      if (q.status && q.status !== "pending") continue;
      live.add(rk);
      if (!q.sessionKey || !post(q.sessionKey) || asked.has(rk)) continue;
      const req = { kind: "question", id: q.id, asks: new Map(), answers: {} };
      asked.set(rk, req);
      for (const one of q.questions || []) {
        const made = ctx.emit({ e: "ask", thread: q.sessionKey, kind: one.options?.length ? "choice" : "text", title: one.question, detail: one.header || "", options: (one.options || []).slice(0, 6).map((o) => ({ label: short(o.label, 80), detail: short(o.description, 140) || null })), key: `${rk}:${one.id}`, blocks: true });
        if (made) req.asks.set(made.qid, one.id);
      }
    }
    // Answered or expired in OpenClaw itself: forget it, and an approval's prompt leaves the post. Its turn's end
    // would close it too, but that end can go unseen: a run that started after its session was read, whose approval
    // was, and that ended before the next look, never showed as running here.
    for (const [rk, r] of [...asked]) {
      if (live.has(rk) || (r.kind === "approval" ? approvals : r.kind === "tool" ? toolAsks : qs) == null) continue;
      asked.delete(rk);
      const q = r.qid && ctx.state.questions.find((x) => x.id === r.qid);
      if (q && !q.answered) ctx.emit({ e: "fact", op: { t: "question.answer", qid: r.qid, value: null, by: "terminal" } });
    }
  }

  // Forgotten only once OpenClaw has taken it: until then it lists it as open, and syncAsks would ask it again.
  // One it refused is asked again, so you can answer it. Approvals over the connection they were listed on.
  const resolved = (rk, method, params, over = call) => over(method, params).finally(() => asked.delete(rk));
  const APPROVALS = { approval: "exec.approval.resolve", tool: "plugin.approval.resolve" };

  async function answer(key, e) {
    if (e.type === "permission") {
      const r = asked.get(e.request_id);
      if (!APPROVALS[r?.kind]) return false;
      await resolved(e.request_id, APPROVALS[r.kind], { id: r.id, decision: e.behavior === "allow" ? "allow-once" : "deny" }, ownerCall);
      return true;
    }
    for (const [rk, r] of asked) {
      if (r.kind !== "question" || !r.asks.has(e.question_id)) continue;
      r.answers[r.asks.get(e.question_id)] = e.skipped || e.value == null ? [] : [String(e.value)];
      if (Object.keys(r.answers).length === r.asks.size) await resolved(rk, "question.resolve", { id: r.id, answers: { answers: r.answers } });
      return true;
    }
    return false;
  }

  /* ---------- keeping up ---------- */

  // Every session, a page at a time (cron runs and subagents' fill most of them).
  async function listSessions() {
    const rows = [];
    const keys = new Set();
    for (let offset = 0; ; ) {
      const r = await call("sessions.list", { limit: PAGE, ...(offset ? { offset } : {}) });
      const page = (r?.sessions || []).filter((x) => !keys.has(x.key));
      for (const x of page) keys.add(x.key);
      rows.push(...page);
      if (!r?.hasMore || !page.length) return rows;
      offset = Number(r.nextOffset) || offset + page.length;
    }
  }

  // Its sessions from before, for the welcome card (plugin/cli/history.ts). Those picked come in with the next sync,
  // as its recent ones do.
  async function pastList(): Promise<PastSession[]> {
    if (!enabled) return [];
    return (await listSessions()).filter((row) => shown(row) && !threadJob(row.key)).map((row) => ({ id: row.key, at: Number(row.updatedAt || row.lastActivityAt) || 0, cwd: null }));
  }

  // Its agents, its sessions (each a thread, read again once it changed), what they ask, its routines and skills:
  // every few seconds (loop), and at once when its gateway says something changed (soon). It fails when OpenClaw
  // can't be reached, and the loop waits longer before it tries again.
  async function sync() {
    if (!enabled) return;
    try {
      if (Date.now() - agentsAt > 5 * 60e3) await loadAgents();
      if (Date.now() - presenceAt > 5 * 60e3) await loadPresence();
      const rows = await listSessions();
      if (!gw && !connected) reached(true); // through the command; a gateway's connection says for itself
      connected = true;
      lastError = null;
      noteHomes(rows);
      noteWorkers(rows); // before its posts' quiet is looked at: one whose worker works on isn't over
      const since = ctx.pastSince ? ctx.pastSince("openclaw", DAYS) : Math.max(DAYS ? Date.now() - DAYS * 86400e3 : 0, ctx.historyFrom() || 0);
      for (const row of rows) {
        if (!shown(row)) continue;
        const updated = Number(row.updatedAt || row.lastActivityAt) || 0;
        const active = !!row.hasActiveRun;
        if (!post(row.key) && !active && updated < since) continue;
        const se = session(row.key);
        // A job's thread starts with the first run that says something.
        if (!post(row.key) && threadJob(row.key)) {
          if (updated === se.updated) continue;
          se.updated = updated;
          if (!reported(await call("chat.history", { sessionKey: row.key, limit: 200 }))) continue;
          se.updated = 0;
        }
        se.running = active;
        // Its post first, at once; its history (its first message, its conversation, its steps) follows. None:
        // it's kept off agentbook (Private terminals), and read once it's let on.
        ensurePost(row);
        if (ctx.keptOff(row.key)) continue;
        if (!se.loaded) catchUp(row.key);
        else if (updated !== se.updated || active) await readHistory(row.key).catch((e) => log(`openclaw history ${row.key}: ${e.message}`));
        se.updated = updated;
        setActive(row.key, active, updated);
      }
      await syncAsks();
      if (Date.now() - jobsAt > CRON_MS) await loadRoutines();
      if (Date.now() - skillsAt > SKILLS_MS) await loadSkills();
      else if (skillsDue) noteSkills();
    } catch (e) {
      if (!gw && (connected || !downSince)) reached(false);
      connected = false;
      throw e;
    }
  }

  /* ---------- what you send ---------- */

  const idem = () => `ab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  // The files you attach go to OpenClaw with your message, in base64, rather than as paths on this machine,
  // which its agents may not be on. OpenClaw takes a picture up to 6 MB and another file up to 20 MB (unless
  // its gateway is set to take more), all of a message's in one frame of up to 25 MB; through the openclaw
  // command, only as much as fits on a command line. What doesn't fit stays here, and the post says so.
  function attachmentsOf(files: (AnswerFile | FileEvent | SentFile)[] = []) {
    let room = gw ? 24 << 20 : 700 << 10;
    const attachments = [];
    const left = [];
    for (const f of files) {
      let buf;
      try {
        buf = fs.readFileSync(f.path);
      } catch {
        left.push(`${f.name} (it's gone from agentbook)`);
        continue;
      }
      const mimeType = MIME[path.extname(f.name).slice(1).toLowerCase()] || "application/octet-stream";
      const picture = mimeType.startsWith("image/");
      const content = buf.toString("base64");
      if (buf.length > (picture ? 6 << 20 : 20 << 20)) left.push(`${f.name} (OpenClaw takes ${picture ? "pictures up to 6 MB" : "files up to 20 MB"})`);
      else if (content.length > room) left.push(`${f.name} (${gw ? "it's more than OpenClaw takes in one message" : "it's too big to send through the openclaw command; connect agentbook to the gateway to send it"})`);
      else {
        room -= content.length;
        attachments.push({ type: picture ? "image" : "file", mimeType, fileName: f.name, content, sizeBytes: buf.length });
      }
    }
    return { attachments, left };
  }
  const leftBehind = (key, left) => left.length && ctx.emit({ e: "message", thread: key, from: "agent", via: "dash", text: `agentbook couldn't send ${left.join(", ")} to OpenClaw.` });
  // What the core's delivery makes of what's queued for a thread: a message, with the files you attached.
  // `command`: a slash command, which OpenClaw runs as it does one typed in Telegram, and never steers into a run.
  // `owner`: all of it is this machine's owner's own words (delivery.ts), which go over the owner's connection.
  async function send(key: string, text: string, files: (AnswerFile | FileEvent)[] = [], { command = null, owner = false }: Partial<SendOpts> = {}) {
    const se = session(key);
    const { attachments, left } = attachmentsOf(files);
    leftBehind(key, left);
    if (!text.trim() && !attachments.length) return;
    await (owner ? ownerCall : call)("chat.send", { sessionKey: key, message: text, idempotencyKey: idem(), ...(attachments.length ? { attachments } : {}), ...(se.active && !command ? { queueMode: "steer" } : {}) }, attachments.length ? 120e3 : 30000);
    if (!se.active) setActive(key, true);
    setTimeout(() => void loop?.now(), 1500).unref?.();
  }

  // A new session with one of its agents, in the agent's own workspace, under a key agentbook picks, with the
  // files you attached, in the mode picked for it (none: the gateway's own), over its owner's connection. It's named as its thread
  // is (`title`): OpenClaw names only the sessions its own apps start, so its list would show the key. A gateway from
  // before sessions had a permission mode, or a name given at the start, turns that field away: the session starts
  // without it, and the thread says so for the mode.
  async function start({ agent, prompt, shown = prompt, title, files = [], lid, mode }: StartRequest) {
    const id = String(agent).startsWith(AGENT) ? String(agent).slice(AGENT.length) : "main";
    const { attachments, left } = attachmentsOf(files);
    const displayName = title ? short(title, 120) : "";
    const permissionMode = mode ? PERMISSION_MODES[mode] : undefined;
    let params: Record<string, unknown> = { agentId: id, key: `agentbook-${lid}`, message: prompt, idempotencyKey: lid, ...(displayName ? { displayName } : {}), ...(permissionMode ? { permissionMode } : {}), ...(attachments.length ? { attachments } : {}) };
    const create = (p: Record<string, unknown>) => ownerCall("sessions.create", p, attachments.length ? 120e3 : 30000);
    let r;
    for (;;) {
      try {
        r = await create(params);
        break;
      } catch (e) {
        const refused = ["permissionMode", "displayName"].find((k) => k in params && e.message.includes(k));
        if (!refused) throw e;
        const { [refused]: _, ...rest } = params;
        params = rest;
      }
    }
    const unmoded = !!permissionMode && !("permissionMode" in params);
    if (r?.runStarted === false && r.runError) throw new Error(r.runError.message || String(r.runError));
    const key = r.key;
    session(key);
    // Its history has the prompt as yours: the thread shows what you posted instead.
    ctx.echo(key, prompt);
    ensurePost({ key, agentId: id, createdAt: Date.now(), updatedAt: Date.now(), ...("displayName" in params ? { displayName } : {}) }, { lid, prompt });
    ctx.emit({ e: "message", thread: key, from: "human", via: "dash", text: shown, files: files.map((f) => f.id), resume: lid });
    if (unmoded) ctx.emit({ e: "message", thread: key, from: "agent", via: "dash", text: "This OpenClaw gateway doesn't take a mode for a session yet, so it works in the gateway's own." });
    leftBehind(key, left);
    setActive(key, true);
    return { id: key };
  }

  async function interrupt(key: string) {
    await call("sessions.abort", { key, clearQueued: true });
  }

  async function read(key: string) {
    const se = session(key);
    if (!se.loaded) await readHistory(key);
    return se.digest;
  }

  /* ---------- files in its workspace ---------- */

  // A file its agent names, read through the gateway from the session's workspace on the gateway's machine
  // (sessions.files.get), so it opens wherever OpenClaw runs. It reads text and pictures, up to 256 KB (a
  // picture up to 5 MB, from its agent's workspace: see bigPicture), and nothing outside the workspace; what it
  // won't read (a video, a sound) comes a piece at a time instead (`stream`, see gatewayFile). A folder it won't
  // read is listed (sessions.files.list) from the workspace's root, which it says. What comes back: { root,
  // path, name, size, modified } and a folder's `entries` (`truncated` past 250), or a file's `text` or `bytes`
  // (a picture), or neither (a kind it doesn't read). It fails with a `status` when there's no such file, or
  // it's too big.
  const roots = new Map(); // session key -> its workspace's root, as the gateway gives it
  const failed = (e, type) => e.data?.type === type || e.message.includes(type === "session_file_too_large" ? "too large" : "not found");
  const refused = (status, message) => Object.assign(new Error(message), { status });
  async function file(key, asked) {
    const p = asked.length > 1 ? asked.replace(/\/+$/, "") : asked;
    try {
      const r = await call("sessions.files.get", { sessionKey: key, path: p });
      if (r.root) roots.set(key, r.root);
      const f = r.file;
      const full = r.root && f.workspacePath ? path.posix.join(r.root, f.workspacePath) : f.path;
      const head = { root: r.root || path.posix.dirname(full), path: full, name: f.name || path.posix.basename(full), size: f.size, modified: iso(f.updatedAtMs) };
      if (typeof f.content !== "string") return (await bigPicture(key, head)) || head;
      return f.contentEncoding === "base64" ? { ...head, bytes: Buffer.from(f.content, "base64") } : { ...head, text: f.content };
    } catch (e) {
      if (failed(e, "session_file_too_large")) throw refused(413, `${asked} is too big to open from OpenClaw${e.data?.size ? ` (${Math.ceil(e.data.size / 1024)} KB)` : ""}: it opens files up to 256 KB.`);
      if (!failed(e, "session_file_not_found")) throw e;
    }
    if (!roots.has(key)) roots.set(key, (await call("sessions.files.list", { sessionKey: key })).root || null);
    const root = roots.get(key);
    const cwd = post(key)?.cwd;
    const where = root || cwd || "its workspace";
    if (!root) throw refused(404, `There's no ${asked} in ${where}.`);
    // Its own paths go from the session's folder, when that's in the workspace, or else from the root.
    const from = [cwd && !path.posix.relative(root, cwd).startsWith("..") ? cwd : null, root].filter(Boolean);
    const rels = [...new Set(from.map((b) => path.posix.relative(root, path.posix.resolve(b, p))))].filter((r) => !r.startsWith("..") && !path.posix.isAbsolute(r));
    if (!rels.length) throw refused(404, `There's no ${asked} in ${where}: OpenClaw only opens files in its workspace.`);
    for (const rel of rels) {
      const b = (await call("sessions.files.list", { sessionKey: key, path: rel }))?.browser;
      if (b?.path !== rel) continue;
      const entries = (b.entries || []).filter((e) => !e.name.startsWith(".")).map((e) => ({ name: e.name, dir: e.kind === "directory" }));
      const full = rel ? path.posix.join(root, rel) : root;
      return { root, path: full, name: path.posix.basename(full), entries, truncated: !!b.truncated };
    }
    throw refused(404, `There's no ${asked} in ${where}.`);
  }

  // A picture over the 256 KB sessions.files.get hands over comes back without its bytes. The agent's own
  // workspace hands it over up to 5 MB (agents.workspace.get, OpenClaw 2026.7 on), when it's in there. Null when
  // it isn't, or OpenClaw won't.
  const PICTURE = /\.(avif|bmp|gif|heic|heif|jpe?g|png|webp)$/i;
  async function bigPicture(key, head) {
    const a = keyAgent(key);
    const rel = path.posix.relative(agents.get(a)?.workspace || head.root, head.path);
    if (!PICTURE.test(head.name) || !rel || rel.startsWith("..") || path.posix.isAbsolute(rel) || head.size > 5 << 20) return null;
    try {
      const f = (await call("agents.workspace.get", { agentId: a, path: rel }))?.file;
      return f?.encoding === "base64" && typeof f.content === "string" ? { ...head, bytes: Buffer.from(f.content, "base64") } : null;
    } catch {
      return null;
    }
  }

  /* ---------- an agent's workspace ---------- */

  // An agent's workspace, on its profile under Files: the folder on the gateway's machine where it keeps its
  // AGENTS.md, SOUL.md and MEMORY.md, its memory/ notes and whatever else it writes. OpenClaw looks through a
  // workspace for one of its sessions (sessions.files), so agentbook does it for one of the agent's own that
  // works there (`homes`): its main session, or else its latest. One without any has only the files OpenClaw
  // makes it of (agents.files: AGENTS.md, SOUL.md, MEMORY.md…).
  // What's in it is read when its profile asks: again once the agent did something since (`at`, which a
  // profile watches), and otherwise after a minute. Folders are listed nearest first, 500 of them at most and
  // for 10 seconds at most (a page waits 30 for it), leaving out hidden ones and what tools fill (node_modules);
  // the rest, and one it couldn't list, are listed when one's opened (`dir`), from there the same way.
  const homes = new Map(); // OpenClaw agent id -> { key, rank, at }: the session to look through, and when the agent last did something
  const looked = new Map(); // OpenClaw agent id (and folder) -> { data, at, done, busy, busyFor }: what's in it, when it was read, for which `at`
  const WS_DIRS = Number(process.env.AGENTBOOK_OPENCLAW_WS_DIRS || 500);
  const WS_MS = Number(process.env.AGENTBOOK_OPENCLAW_WS_MS || 10e3);
  const WS_FILES = 5000;
  const WS_READERS = 8; // folders listed at once
  const FILLED = new Set(["node_modules", "dist", "build", "coverage", "target", "venv", "__pycache__"]);
  const atHome = (row) => !row.spawnedBy && !row.subagentRole && !row.spawnedCwd && !row.spawnedWorkspaceDir && !row.repositoryWorkspaceId && !row.execNode;
  function noteHomes(rows) {
    const next = new Map();
    for (const row of rows) {
      const a = row.agentId || keyAgent(row.key);
      const h = next.get(a) || { key: null, rank: -1, at: 0 };
      const at = Number(row.updatedAt || row.lastActivityAt) || 0;
      h.at = Math.max(h.at, at);
      const rank = row.key === `agent:${a}:main` ? Infinity : at;
      if (atHome(row) && rank > h.rank) Object.assign(h, { key: row.key, rank });
      next.set(a, h);
    }
    const moved = [...next].some(([a, h]) => homes.get(a)?.at !== h.at);
    homes.clear();
    for (const [a, h] of next) homes.set(a, h);
    if (moved) changed();
  }
  // What its profile watches: when the agent last did something, which is when its workspace may have changed.
  const workspaceOf = (id) => (agents.has(id.slice(AGENT.length)) ? { at: iso(homes.get(id.slice(AGENT.length))?.at || null) } : null);

  // What's in it: { root, files: [{ path, size, modified }], dirs: [{ path, modified, listed }], more, core }.
  // Paths go from its root. `more`: there's more than was listed; `core`: only the files OpenClaw makes it of.
  // `dir`: what's in one of its folders (by its path from the root), for one that wasn't listed.
  async function workspace(id, dir = "") {
    const a = id.slice(AGENT.length);
    if (!agents.has(a)) return null;
    const at = homes.get(a)?.at || 0;
    const k = dir ? `${a}\0${dir}` : a;
    if (!looked.has(k)) looked.set(k, {});
    const c = looked.get(k);
    if (c.data && c.done === at && Date.now() - c.at < 60e3) return c.data;
    if (c.busy && c.busyFor === at) return c.busy;
    // Read while the agent was doing something else: once that's done, read again.
    const before = c.busy;
    const busy = (async () => {
      await before?.catch(() => {});
      const key = homes.get(a)?.key;
      if (dir && !key) throw refused(404, `Until ${agentName(a)} has a thread, OpenClaw shows only the files it keeps for it (AGENTS.md, SOUL.md, MEMORY.md…).`);
      const data = dir ? await walk(key, dir) : key ? await walk(key).catch(() => coreFiles(a)) : await coreFiles(a);
      Object.assign(c, { data, at: Date.now(), done: at });
      return data;
    })().finally(() => c.busy === busy && (c.busy = null));
    Object.assign(c, { busy, busyFor: at });
    return busy;
  }
  async function walk(key, from = "") {
    const files = [];
    const dirs = [];
    let root = null;
    let more = false;
    let found = false;
    let left = WS_DIRS;
    const until = Date.now() + WS_MS;
    const opening = new Map(); // path -> its folder in `dirs`, while it's to be listed
    for (let level = [from]; level.length; ) {
      left -= level.length;
      // A folder it can't list, or doesn't get to in time, isn't listed; the one it starts from it can't list, it can't show.
      const lists = await pool(level, WS_READERS, (dir) => (dir !== from && Date.now() > until ? null : call("sessions.files.list", { sessionKey: key, ...(dir ? { path: dir } : {}) }).catch((e) => (dir !== from ? null : Promise.reject(e)))));
      const next = [];
      level.forEach((dir, i) => {
        const r = lists[i];
        root ||= r?.root || null;
        const b = r?.browser;
        if (b?.path !== dir) {
          if (dir !== from) opening.get(dir).listed = false;
          return;
        }
        if (dir === from) found = true;
        if (b.truncated) more = true;
        for (const e of b.entries || []) {
          if (e.name.startsWith(".")) continue;
          const p = dir ? `${dir}/${e.name}` : e.name;
          if (e.kind === "directory") {
            const opens = !FILLED.has(e.name) && left > next.length;
            const d = { path: p, modified: iso(e.updatedAtMs), listed: opens };
            dirs.push(d);
            if (opens) {
              next.push(p);
              opening.set(p, d);
            }
          } else if (e.kind !== "file") continue;
          else if (files.length < WS_FILES) files.push({ path: p, size: e.size ?? null, modified: iso(e.updatedAtMs) });
          else more = true;
        }
      });
      level = next;
    }
    if (!root) throw refused(404, "OpenClaw didn't say where its workspace is.");
    if (from && !found) throw refused(404, `There's no ${from} in ${root}.`);
    return { root, files, dirs, more, core: false, ...(from ? { dir: from } : {}) };
  }
  async function coreFiles(a) {
    const r = await call("agents.files.list", { agentId: a });
    const files = (r?.files || []).filter((f) => !f.missing).map((f) => ({ path: f.name, size: f.size ?? null, modified: iso(f.updatedAtMs) }));
    return { root: r?.workspace || agents.get(a)?.workspace || "", files, dirs: [], more: false, core: true };
  }
  // One of its files (or folders), as a post's are (see file): through its session, or else by its name.
  async function workspaceFile(id, asked) {
    const a = id.slice(AGENT.length);
    if (!agents.has(a)) throw refused(404, "No such agent");
    const key = homes.get(a)?.key;
    if (key) return file(key, asked);
    const name = path.posix.basename(asked);
    let r;
    try {
      r = await call("agents.files.get", { agentId: a, name });
    } catch (e) {
      throw /unsupported file|not found|missing/i.test(e.message) ? refused(404, `Until ${agentName(a)} has a thread, OpenClaw shows only the files it keeps for it (AGENTS.md, SOUL.md, MEMORY.md…).`) : e;
    }
    const f = r?.file;
    if (!f || f.missing) throw refused(404, `There's no ${asked} in ${r?.workspace || "its workspace"}.`);
    return { root: r.workspace || path.posix.dirname(f.path), path: f.path, name: f.name, size: f.size, modified: iso(f.updatedAtMs), text: f.content ?? "" };
  }

  // One it can't read (a video, a sound, a file over 256 KB that isn't text or a picture), as it's wanted, a
  // piece at a time, through the session it looks through the workspace with (see gatewayFile).
  function workspaceStream(id, p, opts) {
    const key = homes.get(id.slice(AGENT.length))?.key;
    if (!key) return Promise.reject(refused(404, "Until it has a thread, OpenClaw shows only the files it keeps for it (AGENTS.md, SOUL.md, MEMORY.md…)."));
    return gatewayFile(key, p, opts);
  }

  /* ---------- media in its messages ---------- */

  // A picture, sound, video or file from one of its messages, by what its file on the post keeps (see
  // mediaOf), as it comes (a Response, for agentbook to keep). OpenClaw hands it over (artifacts.download) in
  // base64, or as a short-lived link on its gateway, which agentbook follows: on the gateway it connects to, or
  // else the one `openclaw` reaches on this machine (OPENCLAW_GATEWAY_URL, or its own port). A link anywhere else
  // it doesn't follow. The link has two minutes to start; the rest takes as long as it takes (`signal` stops it),
  // as a gateway far away can be slow. One over MEDIA_MAX is too big to keep here: it comes from the gateway
  // each time it's wanted, a piece at a time (streamMedia).
  const MEDIA_MAX = Number(process.env.AGENTBOOK_OPENCLAW_MEDIA_MAX || 64 << 20); // bytes
  async function fetchMedia(key: string, ref: FileRemote, { signal }: MediaOpts = {}) {
    const res = ref.source ? await gatewayFile(key, ref.source, { signal }) : await streamMedia(key, ref, { signal });
    if (Number(res.headers.get("content-length")) > MEDIA_MAX) {
      res.body?.cancel().catch(() => {});
      throw refused(413, "This file is too big to show here.");
    }
    return res;
  }
  // Its answer, once it starts (`range`: a piece of it; `signal`: stop when nobody wants it anymore).
  async function streamMedia(key: string, ref: FileRemote, { range, signal }: MediaOpts = {}) {
    if (ref.source) return gatewayFile(key, ref.source, { range, signal });
    const r = await download(key, ref);
    if (r?.encoding === "base64" && typeof r.data === "string") return new Response(Buffer.from(r.data, "base64"));
    const res = await started(linkOf(r), { headers: range ? { range } : {}, signal });
    if (!res.ok) {
      res.body?.cancel().catch(() => {});
      throw refused(res.status === 404 || res.status === 410 ? 404 : res.status === 416 ? 416 : 502, `OpenClaw's gateway wouldn't hand this file over (${res.status}).`);
    }
    return res;
  }
  async function download(key, ref) {
    let id = ref.artifact;
    if (!id) {
      const list = (await call("artifacts.list", { sessionKey: key }))?.artifacts || [];
      const a = (ref.seq != null && list.filter((x) => x.messageSeq === ref.seq)[ref.n]) || (ref.title && list.find((x) => x.type === ref.type && x.title === ref.title));
      if (!a) throw refused(404, "OpenClaw doesn't have this file anymore.");
      id = a.id;
    }
    try {
      return await call("artifacts.download", { sessionKey: key, artifactId: id }, 60000);
    } catch (e) {
      if (e.data?.type === "artifact_not_found" || /artifact not found/.test(e.message)) throw refused(404, "OpenClaw doesn't have this file anymore.");
      throw e;
    }
  }
  // A file from the gateway, once it starts coming: it has two minutes to start; the rest takes as long as it
  // takes, until `signal` stops it.
  async function started(url: URL, { headers, signal }: { headers?: Record<string, string>; signal?: AbortSignal } = {}) {
    const ctl = new AbortController();
    const late = setTimeout(() => ctl.abort(new Error("OpenClaw's gateway took too long to hand this file over.")), 120e3);
    if (signal?.aborted) ctl.abort(signal.reason);
    signal?.addEventListener("abort", () => ctl.abort(signal.reason), { once: true });
    try {
      return await fetch(url, { headers, signal: ctl.signal });
    } finally {
      clearTimeout(late);
    }
  }
  function linkOf(r) {
    const base = gatewayHttp();
    const url = typeof r?.url === "string" ? new URL(r.url.startsWith("/") ? base.pathname.replace(/\/$/, "") + r.url : r.url, base) : null;
    if (!url || url.origin !== base.origin) throw refused(404, "OpenClaw can't hand this file over to agentbook.");
    return url;
  }
  // A file on the gateway's machine (one an agent sent with a MEDIA: line, or one in its workspace), the way
  // OpenClaw's Control UI gets one: over HTTP (assistant-media), signed in as agentbook (its token, or the
  // device token the gateway gave it). OpenClaw hands over what's in its agents' folders (their media, the
  // session's workspace), and pictures elsewhere. Only from a gateway agentbook connects to itself: the openclaw
  // command can't hand one over. A gateway shuts a machine out after a few failed sign-ins, so until one file
  // has come through they're asked for one at a time, and once the gateway turns agentbook away it isn't asked
  // again for an hour.
  const TURNED_AWAY_MS = Number(process.env.AGENTBOOK_OPENCLAW_TURNED_AWAY_MS || 60 * 60e3);
  let sentWorks = false;
  let turnedAway = 0;
  let sentQueue: Promise<unknown> = Promise.resolve();
  function gatewayFile(key: string, source: string, opts?: MediaOpts) {
    if (sentWorks) return askGateway(key, source, opts);
    const turn = sentQueue.then(() => askGateway(key, source, opts));
    sentQueue = turn.catch(() => {});
    return turn;
  }
  // Its answer, once it starts (`range`: a piece of it, as a player asks; `signal`: stop when nobody wants it
  // anymore).
  async function askGateway(key: string, source: string, { range, signal }: MediaOpts = {}) {
    const s = settings();
    const auth = s.token || s.password || readConfig().device?.deviceToken;
    if (!gw || !s.url || !auth) throw refused(404, "agentbook can open this file only from a gateway it connects to itself (in Add agents).");
    if (Date.now() - turnedAway < TURNED_AWAY_MS) throw refused(503, "OpenClaw's gateway turned agentbook away when it asked for a file, so agentbook waits a while before asking again.");
    const res = await started(mediaUrl(key, source), { headers: { authorization: `Bearer ${auth}`, ...(range ? { range } : {}) }, signal });
    if (res.status === 401 || res.status === 403 || res.status === 429) {
      res.body?.cancel().catch(() => {});
      turnedAway = Date.now();
      sentWorks = false;
      log(`openclaw: the gateway turned agentbook away (${res.status}) when it asked for ${source}; not asking for files again for a while`);
      throw refused(503, "OpenClaw's gateway turned agentbook away when it asked for this file, so agentbook waits a while before asking again.");
    }
    if (!res.ok) {
      res.body?.cancel().catch(() => {});
      if (res.status === 404) throw refused(404, await whyNot(key, source, auth));
      throw refused(res.status === 416 ? 416 : 502, `OpenClaw's gateway wouldn't hand this file over (${res.status}).`);
    }
    sentWorks = true;
    return res;
  }
  function mediaUrl(key, source) {
    const base = gatewayHttp();
    const url = new URL(`${base.pathname.replace(/\/$/, "")}/__openclaw__/assistant-media`, base);
    url.searchParams.set("source", source);
    url.searchParams.set("sessionKey", key);
    return url;
  }
  // Why the gateway won't hand a file over, as its Control UI asks it (meta=1): it isn't there anymore (what an
  // agent sends goes a day after), or it's outside the folders the agent shares. A gateway that doesn't say gets
  // the vaguer answer.
  async function whyNot(key, source, auth) {
    const name = path.posix.basename(source);
    let code = null;
    try {
      const url = mediaUrl(key, source);
      url.searchParams.set("meta", "1");
      const r = await fetch(url, { headers: { authorization: `Bearer ${auth}` }, signal: AbortSignal.timeout(15e3) });
      code = r.ok ? ((await r.json()) as { code?: string })?.code || null : (r.body?.cancel().catch(() => {}), null);
    } catch {}
    if (code === "file-not-found") return /\/media\/outbound\//.test(source) ? `OpenClaw doesn't have ${name} anymore: it deletes what its agents send a day after they send it, and agentbook hadn't kept a copy.` : `${name} isn't on OpenClaw's machine anymore (it was at ${source}).`;
    if (code === "outside-allowed-folders") return `OpenClaw won't hand ${name} over: it's outside the folders its agent shares (${source}).`;
    return "OpenClaw won't hand this file over: it's gone, or not in a folder its agents share.";
  }
  // The gateway's address over HTTP, where its links are (under its path, for one behind a proxy).
  function gatewayHttp() {
    const u = new URL((gw && settings().url) || process.env.OPENCLAW_GATEWAY_URL || `ws://127.0.0.1:${process.env.OPENCLAW_GATEWAY_PORT || 18789}`);
    u.protocol = u.protocol === "wss:" || u.protocol === "https:" ? "https:" : "http:";
    u.search = u.hash = "";
    return u;
  }

  /* ---------- routines ---------- */

  // Its agents' routines: OpenClaw's cron jobs, each with its schedule, what it's told to do, and how its last
  // run went. They're listed every 30 seconds, and again at once when the gateway says its cron changed, so a
  // profile knows what it has; a routine's runs are asked for when a page wants them. Each run is a session
  // of its own (unless the routine runs in a session that's a post), kept off the feed.
  const payloadText = (p: CronPayload = {}) => (p.kind === "agentTurn" ? p.message : p.kind === "systemEvent" ? p.text : p.kind === "command" ? (p.argv || []).join(" ") : p.kind === "script" ? p.script : "");
  function routineOf(j) {
    const st = j.state || {};
    const d = j.delivery;
    return {
      id: j.id,
      agent: agentId(j.agentId || (j.sessionKey ? keyAgent(j.sessionKey) : defaultAgent)),
      name: j.displayName || j.name,
      description: j.description || "",
      enabled: j.enabled !== false,
      builtin: !!j.declarationKey, // upkeep OpenClaw sets up itself
      kind: j.payload?.kind || null, // agentTurn (a prompt), systemEvent, command, script, heartbeat
      what: String(payloadText(j.payload) || ""),
      model: j.payload?.model || null,
      schedule: j.schedule || null,
      target: j.sessionTarget || "isolated", // a session of its own each run, "main", or "session:<key>"
      delivery: d && d.mode !== "none" ? { mode: d.mode, channel: d.channel || null, to: d.to || null } : null,
      next: j.enabled !== false ? iso(st.nextRunAtMs ?? j.nextRunAtMs) : null,
      running: iso(st.runningAtMs),
      last: iso(st.lastRunAtMs ?? j.lastRunAtMs),
      status: st.lastRunStatus ?? st.lastStatus ?? j.lastRunStatus ?? null, // ok, error, skipped
      error: st.lastError ?? j.lastRunError ?? null,
      took: st.lastDurationMs ?? null,
      failing: st.consecutiveErrors || 0,
      created: iso(j.createdAtMs),
    };
  }
  // A run: when, how long, how it went, what it reported, and its session (`post` when that's a post here).
  const runOf = (r) => ({
    id: r.runId || r.sessionId || `${r.jobId}:${r.ts}`,
    job: r.jobId,
    at: iso(r.runAtMs ?? r.ts),
    took: r.durationMs ?? null,
    status: r.status || null,
    error: r.error || null,
    summary: r.summary || null,
    session: r.sessionKey || null,
    post: r.sessionKey && post(r.sessionKey) ? r.sessionKey : null,
    model: r.model || null,
    delivered: r.deliveryStatus || null,
  });

  let jobsError = null;
  async function loadRoutines() {
    jobsAt = Date.now();
    try {
      const list = [];
      for (let offset = 0; ; ) {
        const r = await call("cron.list", { includeDisabled: true, limit: 200, ...(offset ? { offset } : {}) });
        list.push(...(r?.jobs || []));
        if (!r?.hasMore || !r.jobs?.length) break;
        offset = Number(r.nextOffset) || offset + r.jobs.length;
      }
      jobsError = null;
      const next = list.map(routineOf);
      if (JSON.stringify(next) === JSON.stringify(jobs)) return;
      jobs = next;
    } catch (e) {
      if (jobsError !== e.message) log(`OpenClaw: couldn't list its routines: ${(jobsError = e.message)}`);
      if (jobs === null) return;
      jobs = null;
    }
    changed();
  }

  // What an agent's profile shows of its routines before you open them: how many, the next run, how many
  // failed last time. null: none to show (it isn't OpenClaw's, or the gateway has no cron).
  function routinesOf(id) {
    if (!jobs) return null;
    const mine = jobs.filter((j) => j.agent === id && !j.builtin);
    const next = mine.map((j) => j.next).filter(Boolean).sort()[0] || null;
    const last = mine.map((j) => j.last).filter(Boolean).sort().at(-1) || null;
    return { n: mine.length, paused: mine.filter((j) => !j.enabled).length, failing: mine.filter((j) => j.enabled && j.status === "error").length, failed: failedRoutines(mine), running: mine.filter((j) => j.running).length, next, last };
  }

  const ownJob = (id, job) => jobs?.find((j) => j.id === job && j.agent === id) || null;
  const fresh = () => (Date.now() - jobsAt > 5000 ? loadRoutines() : null);
  const runsOf = async (params) => {
    const r = await call("cron.runs", { limit: 50, sortDir: "desc", ...params });
    return { runs: (r?.entries || []).map(runOf), total: r?.total ?? null, more: !!r?.hasMore };
  };

  // An agent's routines.
  // A job's thread, when it has one, on what its page says of it.
  const withThread = (j) => {
    const key = `agent:${j.agent.slice(AGENT.length)}:cron:${j.id}`;
    return post(key) ? { ...j, post: key } : j;
  };
  async function routines(id) {
    await fresh();
    return jobs && { routines: jobs.filter((j) => j.agent === id).map(withThread) };
  }
  // One of them, with its runs, newest first (`offset` for older ones).
  async function routine(id, job, { offset = 0 } = {}) {
    await fresh();
    const j = ownJob(id, job);
    if (!j) return null;
    return { routine: withThread(j), ...(await runsOf({ scope: "job", id: job, ...(offset ? { offset } : {}) })) };
  }
  // A run, from its session's history: the steps it took and what it said, the last of which is its result.
  // OpenClaw lets go of a run's session once the run is over and idle, and its history comes back empty then
  // (`gone`), not as an error: what the run reported (its summary) is all that's left of it.
  async function routineRun(id, job, key) {
    if (!ownJob(id, job) || keyAgent(key) !== id.slice(AGENT.length)) return null;
    const r = await call("chat.history", { sessionKey: key, limit: 200 });
    const d = blank();
    let reply = null;
    const messages = r?.messages || [];
    for (const entry of messages) {
      const m = entry?.message || entry;
      if (!m?.role) continue;
      const at = iso(m.timestamp || entry.timestamp);
      if (startsTurn(m)) d.turn++;
      const said = fold(d, m, entry.id || m.id || `${m.role}:${m.timestamp}`, at, agents.get(keyAgent(key))?.workspace);
      if (said) reply = { text: said, at };
    }
    return { steps: d.steps.map(({ id, kind, at, tool, title, text, done, error }) => ({ id, kind, at, tool, title, text, done, error })), reply, model: d.model, gone: !messages.length };
  }
  // Run one now, or pause or resume it.
  // OpenClaw does either only for an admin: its owner's, over the owner's connection.
  async function routineDo(id, job, what) {
    if (!ownJob(id, job)) return false;
    try {
      if (what === "run") await ownerCall("cron.run", { id: job, mode: "force" });
      else await ownerCall("cron.update", { id: job, patch: { enabled: what === "resume" } });
    } catch (e) {
      if (/missing scope: operator\.admin/i.test(e.message)) throw new Error("OpenClaw runs, pauses and resumes cron jobs only for an admin: give agentbook admin in this machine’s OpenClaw setup on the Agents tab.");
      throw e;
    }
    await loadRoutines();
    return true;
  }

  // Posts copied before agentbook left out what OpenClaw adds to what's said: what it wrote to its agents
  // goes, and the rest is said again without its notes, a reply's MEDIA: lines becoming its files.
  // Once, and then this list goes: seven copies agentbook got wrong, which its person said to drop on 2026-11-07, by their
  // id in OpenClaw. Three files said again with no words, an answer agentbook passed on shown as the person's, and three cron
  // prompts shown as their agent's words beside the same prompt from its routine. Its rules no longer copy these.
  const WRONG = new Set(["4d4b8581-f7c4-4bac-8185-b0347e61adaa:say", "674e25f2-1898-4be3-b216-bcd17231ab48:say", "ab1f2903-651f-4244-baa8-dacdb94fb057:say", "c4c80ddd-e4e1-421f-b776-1ed68d3b927b", "2abc4203-83bb-47a2-9b5e-13084d548df6:say", "04008b53-bab7-488b-958a-57a36739b7b4:say", "7ef2548a-3d3a-4376-9e7f-acb4ed946feb:say"]);
  function tidy() {
    const drop: Record<string, string[]> = {};
    for (const m of [...ctx.state.messages, ...outOfMemory(ctx.state, "messages")]) {
      if (!m.ext || !String(post(m.post)?.agent || "").startsWith(AGENT)) continue;
      if (WRONG.has(m.ext)) {
        (drop[m.post] ||= []).push(m.id);
        continue;
      }
      let text = m.via === "dash" ? m.text : yoursOf(m.text);
      if (m.from === "agent") {
        const lines = mediaLines(m.text);
        text = lines.text;
        const sent = once([...(m.files || []).map((f) => ({ name: f.name })), ...sentOf(lines.sent)]).filter((x) => x.ref?.source);
        if (sent.length) ctx.emit({ e: "fact", op: { t: "message.files", post: m.post, ext: m.ext, files: keep(m.post, m.ext, sent, "agent") } });
      }
      if (text === m.text) continue;
      if (text === null || (!text && !m.files?.length && !m.file_id)) (drop[m.post] ||= []).push(m.id);
      else ctx.emit({ e: "fact", op: { t: "message.text", post: m.post, ext: m.ext, text } });
    }
    for (const [key, mids] of Object.entries(drop)) ctx.emit({ e: "fact", op: { t: "message.drop", post: key, mids } });
  }

  // Its gateway's providers' usage limits: one read for all its agents, at most once a minute.
  const usage = limitsReader(async () => ({ limits: openclawLimitsOf(await call("usage.status", {}, 20000)), host: hostName() }));

  // Its row on Add agents: whether agentbook reaches OpenClaw, and how.
  function row(): RuntimeRow {
    const oc = connection();
    if (!enabled) return { ok: false, status: "Off", detail: "AGENTBOOK_OPENCLAW=0 leaves it off." };
    if (oc.mode === "gateway") {
      if (oc.state === "connected") return { ok: true, status: "Connected", detail: `Through its gateway at ${oc.url}.` };
      if (oc.state === "pairing") return { ok: false, status: "Waiting for approval", detail: "Approve agentbook on the gateway, below." };
      return { ok: false, status: "Can't reach it", detail: oc.error || `Connecting to ${oc.url}…` };
    }
    if (oc.connected) return { ok: true, status: "Connected", detail: "Through this machine's openclaw command." };
    return { ok: false, status: "Not connected", detail: "Connect to its gateway below, on this machine or another one." };
  }

  const owns = (id: string) => String(id).startsWith(AGENT) && ctx?.state.agents[id]?.kind === "openclaw";

  return {
    id: "openclaw",
    info: RUNTIMES.openclaw,
    // What you send it comes back in its history: the core drops it by its words (see sentHere).
    echoes: "text",
    owns,
    past: { list: pastList, bring: () => sync() },
    connect(c) {
      ctx = c;
      if (!enabled) return;
      tidy();
      linkGateway();
      loop = poll(sync, Number(process.env.AGENTBOOK_OPENCLAW_SYNC_MS || 5000), {
        max: 300e3,
        log: (why, wait) => {
          if (lastError !== why) log(`openclaw: ${(lastError = why)} (trying again in ${Math.round(wait / 1000)}s)`);
        },
      });
    },
    // Its CLI reached its server: pictures it couldn't send up before go now.
    online: () => void (lastListed.length && loadAvatars(lastListed)),
    health: () => ({ enabled, connected, error: lastError, syncing: waiting.length + reading.size }),
    start,
    send: (key, text, files, opts) => send(key, text, files, opts),
    answer: (key, e: PermissionEvent | AnswerEvent) => answer(key, e),
    interrupt,
    read,
    live: (s) => liveOf(sessions.get(s.id)?.digest),
    summary: (s) => summaryOf(sessions.get(s.id)?.digest, s),
    working: (key) => !!sessions.get(key)?.active,
    // Its history is being read, which its thread shows meanwhile.
    syncing: (key) => waiting.includes(key) || reading.has(key),
    blocked: (s) => (JOB_KEY.test(s.id) ? "OpenClaw doesn't take messages in a cron job's own session. Its runs add to this thread." : null),
    resumeCommand: (s) => (JOB_KEY.test(s.id) ? null : `openclaw tui --session ${s.session_id}`),
    commands: { list: (s) => commands(s) },
    workers: { list: workersOf, steps: workerStepsOf },
    // Its agents' files are on the gateway's machine, which may not be this one.
    files: {
      read: (s, p) => file(s.id, p),
      // The files OpenClaw won't hand over whole come a piece at a time only from a gateway it connects to.
      streams: () => !!gw,
      stream: (s, p, opts) => gatewayFile(s.id, p, opts),
      media: (s, ref, opts) => fetchMedia(s.id, ref, opts),
      streamMedia: (s, ref, opts) => streamMedia(s.id, ref, opts),
    },
    workspace: { of: workspaceOf, list: workspace, read: workspaceFile, stream: workspaceStream, skillFile },
    routines: { of: routinesOf, list: routines, get: routine, run: routineRun, act: routineDo },
    limits: { read: (id) => (owns(id) ? usage() : null) },
    remote: { machine: () => hostName(), link },
    setup: { configure: (v) => configure(v as Parameters<typeof configure>[0]), connection, admin: askAdmin },
    row,
  };
}
