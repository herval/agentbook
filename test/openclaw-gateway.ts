#!/usr/bin/env node
// agentbook connecting to an OpenClaw gateway directly (a stand-in, fake-openclaw-gateway.ts): its address and
// token on Add agents, approving agentbook there as a device, its sessions as posts that update on the
// gateway's events, and reconnecting with its device token. Then the same with a setup code. Run: node
// test/openclaw-gateway.ts

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type GatewayState, startGateway } from "./fake-openclaw-gateway.ts";
import type { Part } from "./fake-openclaw-state.ts";
import { type Agentbook, spawnAgentbook, testPort } from "./harness.ts";
import { stateOf } from "./harness-state.ts";
import type { Json } from "./harness-types.ts";

const TEST = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST, "..", "plugin");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-ocgw-"));
const PORT = testPort(4700);
const URL = `http://127.0.0.1:${PORT}`;
const FAKE = path.join(HOME, "gateway");
fs.mkdirSync(FAKE);
const TOKEN = "the-gateway-token-1234";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
// No openclaw command here, and a slow poll: what shows up comes through the connection and its events.
const env = { ...process.env, AGENTBOOK_HOME: HOME, AGENTBOOK_PORT: String(PORT), AGENTBOOK_CODEX: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_TERMINAL: "0", AGENTBOOK_CLAUDE: "/usr/bin/false", AGENTBOOK_OPENCLAW_BIN: path.join(HOME, "no-openclaw-here"), AGENTBOOK_OPENCLAW_SYNC_MS: "60000", AGENTBOOK_OPENCLAW_TURNED_AWAY_MS: "1500", AGENTBOOK_OPENCLAW_MEDIA_MAX: String(1 << 20), AGENTBOOK_MEDIA_STALL_MS: "1500", AGENTBOOK_MEDIA_SOME: String(64 << 10), AGENTBOOK_MEDIA_AHEAD: String(256 << 10), AGENTBOOK_CLOUD_SYNC_MS: "600000" };
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_URL", "AGENTBOOK_OPENCLAW", "AGENTBOOK_OPENCLAW_URL", "AGENTBOOK_OPENCLAW_TOKEN"]) delete env[k];

const now = Date.now();
const STATE = path.join(FAKE, "state.json");
const edit = (fn: (s: GatewayState) => void) => {
  const s: GatewayState = JSON.parse(fs.readFileSync(STATE, "utf8"));
  fn(s);
  fs.writeFileSync(`${STATE}.t`, JSON.stringify(s, null, 1));
  fs.renameSync(`${STATE}.t`, STATE);
};
fs.writeFileSync(
  STATE,
  JSON.stringify({
    agents: [{ id: "main", identity: { name: "jefepato" }, workspace: "/home/me/.openclaw/workspace" }],
    sessions: [{ key: "agent:main:main", sessionId: "s1", agentId: "main", derivedTitle: "Trip planning", createdAt: now - 3600e3, updatedAt: now - 60e3, messages: [{ role: "user", content: "Plan the Lisbon trip", timestamp: now - 3600e3 }, { role: "assistant", content: [{ type: "text", text: "Here's a plan." }], timestamp: now - 3500e3 }] }],
    approvals: [],
    questions: [],
  }),
);
const calls = (): Json[] => (fs.existsSync(path.join(FAKE, "calls.jsonl")) ? fs.readFileSync(path.join(FAKE, "calls.jsonl"), "utf8").split("\n").slice(0, -1).filter(Boolean).map((l) => JSON.parse(l)) : []);

let failures = 0;
const check = (cond: unknown, label: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let COOKIE = "";
const req = (p: string, opts: Omit<RequestInit, "headers"> & { headers?: Record<string, string> } = {}) => fetch(URL + p, { ...opts, headers: { ...(opts.headers || {}), ...(COOKIE ? { cookie: COOKIE } : {}) } });
const get = async (p: string): Promise<Json> => (await req(p)).json();
const raw = async (p: string) => (await req(p)).text();
const post = async (p: string, body: unknown = {}): Promise<Json> => {
  const r = await req(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data: Json = await r.json().catch(() => ({}));
  return { status: r.status, ...data };
};
const state = () => stateOf(get);
const until = async <T>(fn: () => T | Promise<T>, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(100);
  }
};
const MAIN = "agent:main:main";

const gw = await startGateway({ dir: FAKE, token: TOKEN, tickMs: 500 });
let server: Agentbook;
let serverLog = "";
async function startServer() {
  server = spawnAgentbook({ env, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", (d) => (serverLog += d));
  server.stderr.on("data", (d) => (serverLog += d));
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(URL + "/api/health")).ok) return;
    } catch {}
    await sleep(100);
  }
}
try {
  await startServer();
  const setup = await fetch(URL + "/api/auth/test-person", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "tester" }) });
  COOKIE = (setup.headers.get("set-cookie") || "").split(";")[0];

  // ---------- connecting ----------
  check((await get("/api/openclaw")).mode === "command", "without a gateway set, agentbook uses the openclaw command");
  const kinds = await until(async () => {
    const r = await get("/api/runtimes");
    return r.runtimes?.find((x) => x.kind === "openclaw")?.status === "Not connected" && r;
  });
  check(kinds?.runtimes.map((x) => x.kind).join() === "claude-code,codex,hermes,openclaw,dsh,antigravity,grok,claude-agent,devin" && kinds.runtimes.find((x) => x.kind === "codex").status === "Off" && kinds.runtimes.find((x) => x.kind === "dsh").status === "Off" && kinds.runtimes.find((x) => x.kind === "grok").status === "Off", "Add agents lists what this machine runs, and whether agentbook found each");
  check((await post("/api/openclaw", { url: "ftp://nope", token: "x" })).status === 400 && (await post("/api/openclaw", { url: gw.url })).status === 400, "it wants a gateway address and a token");
  await post("/api/openclaw", { url: gw.url.replace("ws://", "http://"), token: "the wrong token" });
  const wrong = await until(async () => {
    const o = await get("/api/openclaw");
    return o.state === "failed" && o;
  });
  check(wrong?.mode === "gateway" && wrong.url === gw.url && /token/i.test(wrong.error), "a wrong token says so (and http:// means its WebSocket)");
  await post("/api/openclaw", { url: gw.url, token: TOKEN });
  const pairing = await until(async () => {
    const o = await get("/api/openclaw");
    return o.state === "pairing" && o;
  });
  const [requestId] = gw.requests();
  check(pairing?.requestId === requestId && pairing.deviceId?.length === 64, "a new device waits for approval, with the request to approve");
  check(!(await raw("/api/openclaw")).includes(TOKEN) && !(await raw("/api/q/side") + (await raw("/api/q/feed"))).includes(TOKEN), "the token never comes back to the page");
  const saved = path.join(HOME, "cli", "openclaw.json");
  check((fs.statSync(saved).mode & 0o777) === 0o600 && JSON.parse(fs.readFileSync(saved, "utf8")).device?.privateKey, "it's kept in a file only you can read, with the device's key");
  const hello = gw.connects.at(-1);
  check(hello?.client.id === "gateway-client" && hello.client.mode === "backend" && hello.client.displayName === "agentbook" && hello.scopes.includes("operator.approvals") && hello.caps?.includes("exec-approvals") && hello.caps.includes("plugin-approvals"), "agentbook signs in as an operator client that answers approvals, commands' and tools': OpenClaw refuses a command with nowhere to ask");

  // ---------- approved ----------
  gw.approve(requestId);
  const connected = await until(async () => (await get("/api/openclaw")).state === "connected", 9000);
  // state() asks for the agents and then the threads, so it can have the thread and not yet its agent.
  const first = await until(async () => {
    const s = await state();
    return s.sessions.some((x) => x.id === MAIN) && s.agents.some((a) => a.id === "openclaw-main") && s;
  });
  check(connected && first?.agents.some((a) => a.id === "openclaw-main" && a.name === "jefepato"), "once approved, its agents are profiles");
  check(first?.sessions.find((x) => x.id === MAIN)?.prompt === "Plan the Lisbon trip", "and its sessions posts");
  const oc = (await get("/api/runtimes")).runtimes?.find((x) => x.kind === "openclaw");
  check(oc?.ok && oc.status === "Connected" && oc.detail.includes(gw.url), "and Add agents says it's connected, and where");

  // ---------- live ----------
  edit((s) => {
    const x = s.sessions.find((y) => y.key === MAIN);
    x.messages.push({ role: "user", content: "Add a day in Sintra", timestamp: Date.now(), __openclaw: { transport: { channel: "telegram" } } }, { role: "assistant", content: [{ type: "text", text: "Added." }], timestamp: Date.now() });
    x.updatedAt = Date.now();
  });
  gw.broadcast("sessions.changed", { reason: "chat" });
  const t0 = Date.now();
  const live = await until(async () => (await get(`/api/sessions/${encodeURIComponent(MAIN)}`)).messages?.find((m) => m.text === "Add a day in Sintra"), 4000);
  check(live?.via === "telegram" && Date.now() - t0 < 3000, `a change on the gateway shows at once (${Date.now() - t0}ms), not at the next poll`);
  // A page open on the agent's threads, and one on the feed, as a browser holds them: each list, and what its
  // stream says about it put on it (as app.js's heardFeed does), so a thread that shows only after a reload fails.
  // `v`: the feed's version it watches; `list`: its rows' keys, `records` theirs, and `fresh` the ones it says are new.
  interface Listed {
    ws: WebSocket;
    events: Json[];
    v: unknown;
    list: string[];
    records: Record<string, Json>;
    fresh: string[];
    heard: () => Listed;
  }
  async function openList(ask: string) {
    const l: Listed = {
      events: [],
      ws: new WebSocket(`${URL.replace(/^http/, "ws")}/api/live/ws`, { headers: { cookie: COOKIE, origin: URL } }),
      v: null,
      list: [],
      records: {},
      fresh: [],
      heard: () => {
        for (const { event, data: d } of l.events.splice(0)) {
          if (event !== "feed" || d.v !== l.v) continue;
          if (d.swap || d.gone) l.list = l.list.map((k) => d.swap?.[k] || k).filter((k) => !d.gone?.includes(k));
          if (d.top) l.list.unshift(...d.top.filter((k: string) => !l.list.includes(k)));
          Object.assign(l.records, d.records || {});
          if (d.new) l.fresh = d.new;
        }
        return l;
      },
    };
    l.ws.onmessage = (e) => l.events.push(JSON.parse(e.data));
    const id = await until(async () => l.events.find((m) => m.event === "hello")?.data.live, 5000);
    const q = await get(`/api/q/feed?${ask}&n=20&live=${id}`);
    Object.assign(l, { v: q.watching, list: q.list, records: q.records, fresh: [] });
    return l;
  }
  const lists = { wall: await openList("agent=openclaw-main"), feed: await openList("feed=1") };
  const launched = await post("/api/launch", { prompt: "Find a hotel", agent: "openclaw-main" });
  const NEW = `agent:main:agentbook-${launched.lid}`;
  const reply = await until(async () => (await get(`/api/sessions/${encodeURIComponent(NEW)}`)).messages?.find((m) => m.text === "Got it: Find a hotel"));
  check(calls().some((c) => c.method === "sessions.create") && reply, "posting on its wall starts a session there, and its reply shows");
  const shows = await until(async () => {
    await sleep(200);
    return Object.values(lists).every((l) => l.heard().list[0] === `thread:${NEW}` && l.records[`thread:${NEW}`]);
  }, 5000);
  check(shows && !lists.wall.fresh.includes(`thread:${NEW}`), "and the thread shows on top of the agent's page and the feed open at the time, without a reload or an \"N new\"");
  if (!shows) for (const [name, l] of Object.entries(lists)) console.log(`      ${name}: ${l.list.join(" ")} | new: ${l.fresh.join(" ")}`);
  for (const l of Object.values(lists)) l.ws.close();
  // A picture you attach goes to the gateway with your message, one far bigger than a command line takes too.
  const PHOTO = Buffer.concat([PNG, crypto.randomBytes(2 << 20)]);
  const photo: Json = await (await req("/api/upload?draft=1&name=photo.png", { method: "POST", body: PHOTO })).json();
  await post(`/api/sessions/${encodeURIComponent(MAIN)}/messages`, { text: "Is this the hotel?", files: [photo.id] });
  const sentPhoto = await until(() => calls().find((c) => c.method === "chat.send" && c.params.message === "Is this the hotel?"));
  check(sentPhoto?.params.attachments?.length === 1 && sentPhoto.params.attachments[0].fileName === "photo.png" && Buffer.from(sentPhoto.params.attachments[0].content, "base64").equals(PHOTO), "a picture attached to a message goes to the gateway with it (2 MB of it)");
  edit((s) => (s.files = { "itinerary.md": "# Lisbon\n", "trip.log": { size: 900_000, text: true } }));
  const opened = await get(`/api/sessions/${encodeURIComponent(MAIN)}/file?path=itinerary.md`);
  const tooBig = await get(`/api/sessions/${encodeURIComponent(MAIN)}/file?path=trip.log`);
  check(opened.text === "# Lisbon\n" && opened.path === "/home/me/.openclaw/workspace/itinerary.md" && /trip\.log is too big to open from OpenClaw \(879 KB\)/.test(tooBig.error), "a file its agent names opens from the gateway's machine, or says why not");

  // ---------- what it says while it works ----------
  // Its words and steps show as the gateway adds them to the session's history (session.message), not only once
  // agentbook reads the history again, which a busy gateway can take minutes to answer (held here).
  const mainNow = async () => get(`/api/sessions/${encodeURIComponent(MAIN)}`);
  const mainSteps = async () => (await get(`/api/sessions/${encodeURIComponent(MAIN)}/steps`)).steps || [];
  await until(async () => (await mainNow()).messages?.some((m) => m.text === "Got it: Is this the hotel?"));
  const had = JSON.parse(fs.readFileSync(STATE, "utf8")).sessions.find((y) => y.key === MAIN).messages.length;
  gw.hold("chat.history", true);
  edit((s) => {
    const x = s.sessions.find((y) => y.key === MAIN);
    x.messages.push(
      { role: "user", content: "Find trains to Porto", timestamp: Date.now(), __openclaw: { transport: { channel: "discord" } } },
      { role: "assistant", content: [{ type: "text", text: "Looking up the trains first." }, { type: "toolCall", id: "t-trains", name: "web_search", arguments: { query: "Lisbon to Porto trains" } }], timestamp: Date.now() },
      { role: "toolResult", toolCallId: "t-trains", toolName: "web_search", content: [{ type: "text", text: "CP Alfa Pendular, 2h50" }], isError: false, timestamp: Date.now() },
    );
    x.hasActiveRun = true;
    x.updatedAt = Date.now();
  });
  const t1 = Date.now();
  gw.tell(MAIN, had);
  const working = await until(async () => {
    const st = await mainSteps();
    return st.some((x) => x.kind === "say" && x.text === "Looking up the trains first.") && st.some((x) => x.id === "t-trains" && x.done) && st;
  }, 4000);
  const porto = (await mainNow()).messages?.find((m) => m.text === "Find trains to Porto");
  check(working && porto?.via === "discord" && Date.now() - t1 < 3000, `what it says and does while it works shows as it happens (${Date.now() - t1}ms), while its history takes a while to read`);
  // One that comes after one agentbook never heard of waits for the history, so nothing is missed or out of place.
  edit((s) => {
    const x = s.sessions.find((y) => y.key === MAIN);
    x.messages.push({ role: "assistant", content: [{ type: "text", text: "The 9:00 has seats." }], timestamp: Date.now() }, { role: "assistant", content: [{ type: "text", text: "Booked the 9:00." }], timestamp: Date.now() });
    x.hasActiveRun = false;
    x.updatedAt = Date.now();
  });
  gw.tell(MAIN, had + 4);
  await sleep(500);
  check(!(await mainSteps()).some((x) => x.text === "Booked the 9:00."), "one that skips past what agentbook hasn't heard waits for the history");
  gw.hold("chat.history", false);
  const booked = await until(async () => {
    const d = await mainNow();
    return d.messages?.some((m) => m.from === "agent" && m.text === "Booked the 9:00.") && d;
  });
  const said = (await mainSteps()).filter((x) => x.kind === "say").map((x) => x.text);
  const [looking, seats, done] = ["Looking up the trains first.", "The 9:00 has seats.", "Booked the 9:00."].map((t) => said.indexOf(t));
  check(booked && 0 <= looking && looking < seats && seats < done,"and comes with the rest once the history's read, in order, the turn's last words its reply");
  check(booked && booked.messages.filter((m) => m.text === "Find trains to Porto").length === 1 && booked.messages.filter((m) => m.text === "Booked the 9:00.").length === 1, "and nothing shows twice");

  // A claude-cli agent's turn: the gateway tells of your message and of its own record of the run, all it said joined.
  // What it said on the way comes only from reading the history, Claude Code's transcript read back.
  await sleep(600); // the read that brought the booking is over, so the next one is held
  gw.hold("chat.history", true);
  const cliFrom = JSON.parse(fs.readFileSync(STATE, "utf8")).sessions.find((y) => y.key === MAIN).messages.length;
  const cliAt = Date.now();
  const fromClaude = (id) => ({ api: "anthropic-messages", provider: "claude-cli", __openclaw: { id, importedFrom: "claude-cli" } });
  const allOfIt = "Checking the seats.\n\nSeat 12 is yours.";
  const yourTurn = { role: "user", content: "Pick me a seat", timestamp: cliAt, __openclaw: { id: "cli-you" } };
  const itsRecord = { role: "assistant", api: "cli", provider: "claude-cli", stopReason: "stop", idempotencyKey: "cli-assistant:r1", content: [{ type: "text", text: allOfIt }], timestamp: cliAt + 5, __openclaw: { id: "cli-joined", idempotencyKey: "cli-assistant:r1" } };
  edit((s) => {
    const x = s.sessions.find((y) => y.key === MAIN);
    x.messages.push(yourTurn, itsRecord);
    x.updatedAt = Date.now();
  });
  gw.tell(MAIN, cliFrom);
  await until(async () => (await mainNow()).messages?.some((m) => m.text === "Pick me a seat"), 3000);
  await sleep(400);
  check(!(await mainSteps()).some((x) => x.kind === "say" && x.text === allOfIt), "its record of the run, heard live, waits for what it follows");
  edit((s) => {
    const x = s.sessions.find((y) => y.key === MAIN);
    x.messages.splice(-1, 0, { role: "assistant", ...fromClaude("cli-1"), stopReason: "tool_use", content: [{ type: "text", text: "Checking the seats." }], timestamp: cliAt + 1 }, { role: "assistant", ...fromClaude("cli-2"), stopReason: "tool_use", content: [{ type: "toolcall", id: "t-seat", name: "exec", arguments: { command: "seats" } }], timestamp: cliAt + 2 }, { role: "user", ...fromClaude("cli-3"), content: [{ type: "tool_result", tool_use_id: "t-seat", content: [{ type: "text", text: "12" }] }], timestamp: cliAt + 3 }, { role: "assistant", ...fromClaude("cli-4"), stopReason: "end_turn", content: [{ type: "text", text: "Seat 12 is yours." }], timestamp: cliAt + 4 });
    x.updatedAt = Date.now();
  });
  gw.hold("chat.history", false);
  const pickedSeat = await until(async () => {
    const d = await mainNow();
    return d.messages?.some((m) => m.text === "Seat 12 is yours.") && d;
  });
  await sleep(500);
  const seatSays = (await mainSteps()).filter((x) => x.kind === "say").map((x) => x.text);
  const seatTalk = (await mainNow()).messages || [];
  check(pickedSeat && !seatTalk.some((m) => m.text === allOfIt || m.text === "Checking the seats.") && seatTalk.filter((m) => m.text === "Seat 12 is yours.").length === 1 && seatSays.includes("Checking the seats.") && !seatSays.includes(allOfIt) && (await mainSteps()).some((x) => x.id === "t-seat" && x.done), "its reply is its last words, once, with the rest in its steps");

  // ---------- an answer OpenClaw takes a while to take ----------
  // It's on its way (held here), and each look at OpenClaw's questions in the meantime still finds that one open.
  edit((s) => {
    s.questions = [{ id: "qq-slow", agentId: "main", sessionKey: MAIN, status: "pending", questions: [{ id: "seat", header: "Seat", question: "Window or aisle?", options: [{ label: "Window" }, { label: "Aisle" }] }] }];
  });
  gw.broadcast("question.requested", { id: "qq-slow", sessionKey: MAIN }); // as the gateway tells of a new one: this test polls once a minute
  const openSeats = async () => (await state()).questions.filter((q) => q.post === MAIN && q.title === "Window or aisle?" && !q.answered);
  const seat = (await until(async () => (await openSeats()).length && (await openSeats())))?.[0];
  gw.hold("question.resolve", true);
  await post(`/api/questions/${seat?.id}/answer`, { value: "Aisle" });
  await until(() => gw.holding("question.resolve"));
  const looked = calls().length;
  gw.broadcast("sessions.changed", { reason: "a look" });
  await until(() => calls().slice(looked).some((c) => c.method === "question.list"));
  await sleep(300);
  check(seat && !(await openSeats()).length, "a question you answered isn't asked again while OpenClaw is taking the answer");
  gw.hold("question.resolve", false);
  const seated = await until(() => calls().filter((c) => c.method === "question.resolve" && c.params.id === "qq-slow"));
  check(seated?.length === 1 && JSON.stringify(seated[0].params.answers) === JSON.stringify({ answers: { seat: ["Aisle"] } }), "and it gets your answer, once");

  // A history past 4 MB comes whole, and agentbook stays connected: the gateway compresses what it sends to a
  // client that offers to take it so, and Node 22's WebSocket, which agentbook used to connect with, always offers
  // and drops the connection on a message that unpacks to more than 4 MB.
  const BIG = "agent:main:big";
  const filler = "x".repeat(120 << 10);
  edit((s) => s.sessions.push({ key: BIG, sessionId: "s-big", agentId: "main", derivedTitle: "A long one", createdAt: Date.now() - 60e3, updatedAt: Date.now(), messages: Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: i % 2 ? [{ type: "text", text: `${i} ${filler}` }] : `${i} ${filler}`, timestamp: Date.now() - 60e3 + i * 10 })) }));
  const connectsBefore = gw.connects.length;
  gw.broadcast("sessions.changed", { reason: "test" });
  const big = await until(async () => {
    const d = await get(`/api/sessions/${encodeURIComponent(BIG)}`);
    return d.messages?.some((m) => m.text?.startsWith("0 ")) && d.messages.some((m) => m.text?.startsWith("39 ")) && d;
  }, 15000);
  check(big && gw.connects.length === connectsBefore && (await get("/api/openclaw")).state === "connected", "a history of 4.8 MB comes whole, and agentbook stays connected");

  // ---------- its workers ----------
  // A subagent its agent started (sessions_spawn) is a session of its own, but not a thread: it shows on the thread
  // that started it, with how it's going and the tool it last started (session.tool), and keeps that thread working.
  const WORKER = "agent:main:subagent:render-1";
  const workerSaid = [
    { role: "user", content: "Render the trip video at 1080p", timestamp: Date.now() - 600e3 },
    { role: "assistant", content: [{ type: "text", text: "Checking the cut first." }, { type: "toolCall", id: "tc-w0", name: "read", arguments: { path: "cut.edl" } }], timestamp: Date.now() - 590e3 },
    { role: "toolResult", toolCallId: "tc-w0", toolName: "read", content: [{ type: "text", text: "88 s, 14 clips" }], isError: false, timestamp: Date.now() - 589e3 },
    { role: "assistant", content: [{ type: "toolCall", id: "tc-w1", name: "exec", arguments: { command: "blender -b trip.blend -a" } }], timestamp: Date.now() - 580e3 },
  ];
  edit((s) => s.sessions.push({ key: WORKER, sessionId: "s-w1", agentId: "main", spawnedBy: MAIN, subagentRole: "leaf", label: "Render the trip video", status: "running", hasActiveRun: true, startedAt: Date.now() - 600e3, createdAt: Date.now() - 600e3, updatedAt: Date.now(), messages: workerSaid }));
  gw.broadcast("sessions.changed", { reason: "spawn" });
  gw.broadcast("session.tool", { runId: "r-w1", stream: "tool", sessionKey: WORKER, spawnedBy: MAIN, data: { phase: "start", name: "exec", toolCallId: "tc-w1", args: { command: "blender -b trip.blend -a" } } });
  const rendering = await until(async () => {
    const d = await mainNow();
    return d.workers?.[0]?.step && d;
  }, 6000);
  check(rendering?.effective === "working" && rendering.going?.[0]?.title === "Render the trip video" && rendering.workers.length === 1 && rendering.workers[0].state === "running", "a subagent its agent started shows on its thread, which is working while it runs");
  check(rendering?.workers[0].step.title.includes("blender -b trip.blend"), `with the tool it last started (${rendering?.workers[0].step.title})`);
  // Opened on its thread's page, its steps are read from its own session's history.
  const workerSteps = await get(`/api/sessions/${encodeURIComponent(MAIN)}/workers/${encodeURIComponent(WORKER)}/steps`);
  const [wSaid, wRead, wRender] = workerSteps.steps || [];
  check(workerSteps.n === 2 && rendering.workers[0].n >= 1 && wSaid?.kind === "say" && wSaid.text === "Checking the cut first." && wRead?.done && wRender?.title.includes("blender -b trip.blend") && !wRender.done, "its steps are read from its own history when you open it, the one it's on not done yet");
  check((await req(`/api/sessions/${encodeURIComponent(MAIN)}/workers/agent%3Amain%3Asubagent%3Anope/steps`)).status === 404, "and only a worker of that thread's");
  const feed = await state();
  check(!feed.sessions.some((x) => x.id === WORKER) && feed.sessions.find((x) => x.id === MAIN)?.effective === "working", "and isn't a thread of its own, while its thread is working in the feed");
  // A command it waits to be allowed to run is asked on that thread: it has none of its own, and with agentbook
  // answering approvals, OpenClaw would wait on it up to 30 minutes.
  edit((s) => {
    s.approvals = [{ id: "ap-w1", request: { command: "rm -rf renders/", cwd: "/home/me/trip", agentId: "main", sessionKey: WORKER }, createdAtMs: Date.now(), expiresAtMs: Date.now() + 1800e3 }];
  });
  gw.announce("exec", "ap-w1");
  const workerAsk = await until(async () => (await state()).questions.find((q) => q.post === MAIN && q.kind === "permission" && q.preview === "rm -rf renders/" && !q.answered), 6000);
  check(/subagent “Render the trip video” wants to run a command in \/home\/me\/trip/.test(workerAsk?.detail || ""), `a subagent's approval is asked on the thread it works for, saying it's the subagent's (${workerAsk?.detail || "none"})`);
  if (workerAsk) await post(`/api/questions/${workerAsk.id}/answer`, { value: "deny" });
  check((await until(() => gw.resolves.find((x) => x.params.id === "ap-w1"), 6000))?.params.decision === "deny", "and answered there");
  edit((s) => Object.assign(s.sessions.find((y) => y.key === WORKER), { status: "failed", hasActiveRun: false, endedAt: Date.now(), lastRunError: "Blender ran out of memory", updatedAt: Date.now() }));
  gw.broadcast("sessions.changed", { reason: "ended" });
  const crashed = await until(async () => {
    const d = await mainNow();
    return d.workers?.[0]?.state === "failed" && d;
  }, 6000);
  check(crashed && crashed.effective !== "working" && !crashed.going && crashed.workers[0].error === "Blender ran out of memory" && crashed.workers[0].ended, "once it fails, its thread says so and why, and isn't working on it anymore");

  // ---------- pictures, video, sound and files in its messages ----------
  // A picture you sent on Telegram (in the message itself), and a reply with a picture, a video and a PDF
  // the agent made (OpenClaw's managed media, linked on the gateway), the video in a reply of its own.
  const MP4 = Buffer.from("not really an mp4, but bytes");
  const PDF = Buffer.from("%PDF-1.4 a plan");
  edit((s) => {
    const x = s.sessions.find((y) => y.key === MAIN);
    x.messages.push(
      { role: "user", content: [{ type: "image", data: PNG.toString("base64"), mimeType: "image/png" }], timestamp: Date.now(), __openclaw: { transport: { channel: "telegram" } } },
      { role: "assistant", content: [{ type: "text", text: "Here's the route." }, { type: "image", artifactId: "img_route", url: "/api/chat/media/outgoing/x/img_route/full", alt: "Route map", mimeType: "image/png", sizeBytes: PNG.length }, { type: "attachment", attachment: { artifactId: "doc_plan", kind: "document", label: "plan.pdf", mimeType: "application/pdf", sizeBytes: PDF.length } }], timestamp: Date.now() },
      { role: "assistant", content: [{ type: "video", artifactId: "vid_tour", fileName: "tour", mimeType: "video/mp4", sizeBytes: MP4.length }, { type: "image", artifactId: "img_gone", alt: "Old map", mimeType: "image/png" }], timestamp: Date.now() },
    );
    x.updatedAt = Date.now();
    s.media = { img_route: { base64: PNG.toString("base64"), mimeType: "image/png" }, doc_plan: { base64: PDF.toString("base64"), mimeType: "application/pdf" }, vid_tour: { base64: MP4.toString("base64"), mimeType: "video/mp4" } };
  });
  gw.broadcast("sessions.changed", { reason: "chat" });
  const withMedia = await until(async () => {
    const d = await get(`/api/sessions/${encodeURIComponent(MAIN)}`);
    return d.messages?.find((m) => m.text === "Here's the route.") && d;
  });
  const sentPic = withMedia?.messages.find((m) => m.from === "human" && m.via === "telegram" && m.files?.length);
  const routeMsg = withMedia?.messages.find((m) => m.text === "Here's the route.");
  check(sentPic?.via === "telegram" && sentPic.text === "" && sentPic.files.map((f) => f.name).join() === "picture.png", "a picture you sent it on Telegram shows on the post, even with nothing written");
  check(routeMsg?.from === "agent" && routeMsg.files.map((f) => f.name).join() === "Route map.png,plan.pdf,tour.mp4,Old map.png" && routeMsg.files[1].size === PDF.length, "its reply has the picture, file and video its turn made, named as what they are");
  const fileOf = (name) => routeMsg.files.find((f) => f.name === name);
  const fetched = await until(() => gw.fetches.some((u) => u.includes("vid_tour") && u.includes("mediaTicket=t-vid_tour")));
  const route = await req(`/api/files/${fileOf("Route map.png").id}`);
  check(fetched && route.status === 200 && route.headers.get("content-type") === "image/png" && Buffer.from(await route.arrayBuffer()).equals(PNG), "agentbook fetches what the agent made from the gateway's link (at once, for a new message) and shows it");
  const sentRes = await req(`/api/files/${sentPic.files[0].id}`);
  check(sentRes.status === 200 && Buffer.from(await sentRes.arrayBuffer()).equals(PNG) && calls().some((c) => c.method === "artifacts.list" && c.params.sessionKey === MAIN) && calls().some((c) => c.method === "artifacts.download" && c.params.artifactId.startsWith("artifact_")), "and what you sent from OpenClaw's own record of it");
  const pdf = await req(`/api/files/${fileOf("plan.pdf").id}?download=1`);
  check(pdf.status === 200 && pdf.headers.get("content-type") === "application/pdf" && /attachment/.test(pdf.headers.get("content-disposition")) && Buffer.from(await pdf.arrayBuffer()).equals(PDF), "a file downloads");
  const part = await req(`/api/files/${fileOf("tour.mp4").id}`, { headers: { range: "bytes=4-9" } });
  check(part.status === 206 && part.headers.get("content-type") === "video/mp4" && part.headers.get("content-range") === `bytes 4-9/${MP4.length}` && (await part.text()) === MP4.subarray(4, 10).toString(), "a video plays from wherever it's asked to");
  const lost = await req(`/api/files/${fileOf("Old map.png").id}`);
  check(lost.status === 404 && /doesn.t have this file anymore/.test(((await lost.json()) as { error: string }).error), "one OpenClaw no longer has says so");
  const downloads = calls().filter((c) => c.method === "artifacts.download" && c.params.artifactId === "img_route").length;
  await req(`/api/files/${fileOf("Route map.png").id}`);
  check(downloads === 1 && calls().filter((c) => c.method === "artifacts.download" && c.params.artifactId === "img_route").length === 1, "and once fetched, it's agentbook's to show, without asking OpenClaw again");
  check(!calls().some((c) => c.method === "chat.send" && /picture\.png/.test(c.params.message)), "nothing from them is sent back to OpenClaw");

  // ---------- files an agent sent with MEDIA: lines ----------
  // A reply naming a picture, a video and a file the gateway no longer has, each on a line of its own. The
  // gateway hands one over (assistant-media) to agentbook signed in; while it turns agentbook away, agentbook
  // asks it once, not once per file, and not again for a while.
  const CLIP = Buffer.from("a clip of the tour");
  const SENT = { map: "/home/me/.openclaw/media/outbound/old-town-map---1b2c3d4e-0000-4000-8000-1234567890ab.png", clip: "/home/me/.openclaw/media/outbound/tour-clip.mp4", gone: "/home/me/.openclaw/media/outbound/fado.mp3" };
  gw.turnAway(true);
  edit((s) => {
    const x = s.sessions.find((y) => y.key === MAIN);
    x.messages.push({ role: "user", content: "Show me the old town", timestamp: Date.now() }, { role: "assistant", content: [{ type: "text", text: `The old town.\n\nMEDIA:${SENT.map}\nMEDIA:${SENT.clip}\nMEDIA:${SENT.gone}\n\nWalk it in an hour.` }], timestamp: Date.now() });
    x.updatedAt = Date.now();
    s.sent = { [SENT.map]: { base64: PNG.toString("base64"), mimeType: "image/png" }, [SENT.clip]: { base64: CLIP.toString("base64"), mimeType: "video/mp4" } };
  });
  gw.broadcast("sessions.changed", { reason: "chat" });
  const town = await until(async () => (await get(`/api/sessions/${encodeURIComponent(MAIN)}`)).messages?.find((m) => m.text?.startsWith("The old town.")));
  check(town?.text === "The old town.\n\nWalk it in an hour." && town.files?.map((f) => f.name).join() === "old-town-map.png,tour-clip.mp4,fado.mp3", "a reply's MEDIA: lines are its files, named as OpenClaw names them, not its words");
  await until(() => gw.mediaAsks.length >= 1);
  await sleep(400);
  const awayRes = await req(`/api/files/${town.files[0].id}`);
  check(gw.mediaAsks.length === 1 && awayRes.status === 503 && /waits a while/.test(((await awayRes.json()) as { error: string }).error), "while the gateway turns agentbook away, it's asked once, not once per file, and not again for a while");
  gw.turnAway(false);
  await sleep(1600);
  const [mapRes, clipRes, goneRes] = await Promise.all(town.files.map((f) => req(`/api/files/${f.id}`)));
  const asked = gw.mediaAsks.slice(1);
  check(mapRes.status === 200 && Buffer.from(await mapRes.arrayBuffer()).equals(PNG) && clipRes.status === 200 && (await clipRes.text()) === CLIP.toString() && asked.length === 3 && asked.every((a) => a.auth === `Bearer ${TOKEN}` && a.sessionKey === MAIN) && asked.map((a) => a.source).sort().join() === Object.values(SENT).sort().join(), "then it hands them over to agentbook signed in, by where they are on its machine");
  check(goneRes.status === 404 && /^OpenClaw doesn't have fado\.mp3 anymore: it deletes what its agents send a day after/.test((await goneRes.json()).error) && gw.metaAsks.length === 1 && gw.metaAsks[0].source === SENT.gone, "one it doesn't have says so, and why, as the gateway tells it (meta=1)");
  const sized = await until(async () => (await get(`/api/sessions/${encodeURIComponent(MAIN)}`)).messages?.find((m) => m.text?.startsWith("The old town.") && m.files?.[1]?.size === CLIP.length));
  check(sized?.files[0].size === PNG.length, "and once fetched, each says how big it is");

  // ---------- files an agent sent with the message tool ----------
  // A claude-cli agent sends what it made to Discord as it works (mcp__openclaw__message), then says it "posted
  // it above": those files are its reply's here. Not one it sent somewhere else, a link, or a dry run.
  const CUT = "/home/me/work/out/cube-cut.mp4";
  const STILL = "/home/me/work/out/stills.jpg";
  const ELSEWHERE = "/home/me/work/out/for-the-other-channel.mp4";
  edit((s) => {
    const x = s.sessions.find((y) => y.key === MAIN);
    const t = Date.now();
    const send = (id, input) => ({ type: "tool_use", id, name: "mcp__openclaw__message", input });
    x.messages.push(
      { role: "user", content: "Cut the cube", timestamp: t },
      { role: "assistant", content: [{ type: "text", text: "Rendering." }, send("toolu_still", { action: "send", message: "Test frames:", attachments: [{ type: "image", media: STILL }] })], timestamp: t + 1 },
      { role: "assistant", content: [send("toolu_cut", JSON.stringify({ action: "send", message: "Cube v1", media: CUT })), send("toolu_far", { action: "send", target: "channel:999", media: ELSEWHERE }), send("toolu_link", { action: "send", media: "https://example.com/cube.mp4" }), send("toolu_dry", { action: "send", media: "/home/me/work/out/dry.mp4", dryRun: true })], timestamp: t + 2 },
      { role: "assistant", content: [{ type: "text", text: "The cube is posted above." }], timestamp: t + 3 },
    );
    x.updatedAt = Date.now();
    s.sent = { ...s.sent, [CUT]: { base64: CLIP.toString("base64"), mimeType: "video/mp4" }, [STILL]: { base64: PNG.toString("base64"), mimeType: "image/jpeg" } };
  });
  gw.broadcast("sessions.changed", { reason: "chat" });
  const cube = await until(async () => (await get(`/api/sessions/${encodeURIComponent(MAIN)}`)).messages?.find((m) => m.text === "The cube is posted above."));
  check(cube?.files?.map((f) => f.name).join() === "stills.jpg,cube-cut.mp4", "files an agent sent here with the message tool are on its reply (not one sent elsewhere, a link or a dry run)");
  const cutRes = cube?.files?.[1] && (await req(`/api/files/${cube.files[1].id}`));
  check(cutRes?.status === 200 && (await cutRes.text()) === CLIP.toString() && gw.mediaAsks.some((a) => a.source === CUT && a.sessionKey === MAIN), "and come from the gateway's machine, by where the agent said they are");
  const cubeSteps = await get(`/api/sessions/${encodeURIComponent(MAIN)}/steps`);
  check(cubeSteps.steps?.some((x) => x.title === "Sent cube-cut.mp4") && cubeSteps.steps?.some((x) => x.title === "Sent stills.jpg"), "its steps say what it sent");

  // ---------- videos: one its agent names, and one too big to keep ----------
  // OpenClaw won't hand over a video in its workspace whole (sessions.files.get), so it plays a piece at a time
  // from the gateway's machine; so does one sent with a MEDIA: line that's too big to keep here (over 1 MB in
  // this test).
  const FILM = crypto.randomBytes(1536 << 10);
  const TOUR = "/home/me/.openclaw/media/outbound/long-tour.mp4";
  edit((s) => {
    s.files = { ...s.files, "out/final.mp4": { size: FILM.length } };
    s.sent = { ...s.sent, "/home/me/.openclaw/workspace/out/final.mp4": { base64: FILM.toString("base64"), mimeType: "video/mp4" }, [TOUR]: { base64: FILM.toString("base64"), mimeType: "video/mp4" } };
  });
  const named = await get(`/api/sessions/${encodeURIComponent(MAIN)}/file?path=out/final.mp4`);
  check(named.kind === "video" && named.size === FILM.length && named.peek?.path === "out/final.mp4", "a video its agent names opens to play, though OpenClaw won't hand it over whole");
  const piece = await req(`/api/peek/${named.peek?.id}/out/final.mp4`, { headers: { range: "bytes=100-199" } });
  check(piece.status === 206 && piece.headers.get("content-range") === `bytes 100-199/${FILM.length}` && Buffer.from(await piece.arrayBuffer()).equals(FILM.subarray(100, 200)) && gw.mediaAsks.at(-1).source === "/home/me/.openclaw/workspace/out/final.mp4", "and plays from the gateway's machine, a piece at a time");
  edit((s) => {
    const x = s.sessions.find((y) => y.key === MAIN);
    x.messages.push({ role: "user", content: "The whole tour?", timestamp: Date.now() }, { role: "assistant", content: [{ type: "text", text: `Here it is.\n\nMEDIA:${TOUR}` }], timestamp: Date.now() });
    x.updatedAt = Date.now();
  });
  gw.broadcast("sessions.changed", { reason: "chat" });
  const tour = await until(async () => (await get(`/api/sessions/${encodeURIComponent(MAIN)}`)).messages?.find((m) => m.text === "Here it is." && m.files?.length));
  await sleep(300); // its fetch, which finds it too big to keep
  const tourPiece = tour && (await req(`/api/files/${tour.files[0].id}`, { headers: { range: "bytes=0-99" } }));
  check(tourPiece?.status === 206 && tourPiece.headers.get("content-range") === `bytes 0-99/${FILM.length}` && Buffer.from(await tourPiece.arrayBuffer()).equals(FILM.subarray(0, 100)), "a video sent with a MEDIA: line too big to keep here plays from the gateway, a piece at a time");
  const tourSized = await until(async () => (await get(`/api/sessions/${encodeURIComponent(MAIN)}`)).messages?.find((m) => m.text === "Here it is." && m.files?.[0]?.size === FILM.length));
  check(tourSized && !fs.readdirSync(path.join(HOME, "cli", "files")).some((n) => n.includes("long-tour")), "and says how big it is, with no copy kept here");

  // ---------- a video from a gateway far away ----------
  // It comes slowly (32 KB every 150 ms here): it plays from what's come while the rest comes, a piece further on
  // than that comes from the gateway on its own, and it's kept once it's all here, however long that takes. One
  // that stops coming is let go of (after AGENTBOOK_MEDIA_STALL_MS), and asked for again once the gateway's back.
  const FAR = crypto.randomBytes(768 << 10);
  const STUCK = crypto.randomBytes(256 << 10);
  const keptAs = (name) => fs.readdirSync(path.join(HOME, "cli", "files")).filter((n) => n.includes(name));
  edit((s) => {
    const x = s.sessions.find((y) => y.key === MAIN);
    x.messages.push({ role: "user", content: "Film the walk?", timestamp: Date.now() }, { role: "assistant", content: [{ type: "text", text: "Filmed it." }, { type: "video", artifactId: "vid_far", fileName: "walk", mimeType: "video/mp4", sizeBytes: FAR.length }, { type: "video", artifactId: "vid_stuck", fileName: "stuck", mimeType: "video/mp4", sizeBytes: STUCK.length }], timestamp: Date.now() });
    x.updatedAt = Date.now();
    s.media = { ...s.media, vid_far: { base64: FAR.toString("base64"), mimeType: "video/mp4", chunk: 32 << 10, every: 150 }, vid_stuck: { base64: STUCK.toString("base64"), mimeType: "video/mp4", chunk: 32 << 10, every: 100, stall: 96 << 10 } };
  });
  gw.broadcast("sessions.changed", { reason: "chat" });
  const filmed = await until(async () => (await get(`/api/sessions/${encodeURIComponent(MAIN)}`)).messages?.find((m) => m.text === "Filmed it." && m.files?.length === 2));
  const walkId = filmed?.files[0].id;
  const opening = await req(`/api/files/${walkId}`, { headers: { range: "bytes=0-" } });
  const openingRange = /^bytes 0-(\d+)\/(\d+)$/.exec(opening.headers.get("content-range") || "");
  const openingBytes = Buffer.from(await opening.arrayBuffer());
  check(opening.status === 206 && openingRange && Number(openingRange[2]) === FAR.length && Number(openingRange[1]) + 1 < FAR.length && openingBytes.length >= 64 << 10 && openingBytes.equals(FAR.subarray(0, openingBytes.length)) && keptAs("-walk.mp4").some((n) => n.endsWith(".part")), `a video coming slowly plays from what's come of it while the rest comes (${openingBytes.length >> 10} KB of ${FAR.length >> 10})`);
  const later = await req(`/api/files/${walkId}`, { headers: { range: "bytes=700000-700099" } });
  check(later.status === 206 && later.headers.get("content-range") === `bytes 700000-700099/${FAR.length}` && Buffer.from(await later.arrayBuffer()).equals(FAR.subarray(700000, 700100)) && gw.ranges.some((r) => r.artifact === "vid_far" && r.range === "bytes=700000-700099"), "a piece further on than it's got to comes from the gateway on its own");
  const walkKept = await until(() => keptAs("-walk.mp4").length === 1 && !keptAs("-walk.mp4")[0].endsWith(".part"), 10000);
  const asksForWalk = calls().filter((c) => c.method === "artifacts.download" && c.params.artifactId === "vid_far").length;
  const whole = await req(`/api/files/${walkId}`, { headers: { range: "bytes=0-" } });
  check(walkKept && whole.status === 206 && whole.headers.get("content-range") === `bytes 0-${FAR.length - 1}/${FAR.length}` && Buffer.from(await whole.arrayBuffer()).equals(FAR) && calls().filter((c) => c.method === "artifacts.download" && c.params.artifactId === "vid_far").length === asksForWalk, "it's kept once it's all here, over two seconds after it started, and plays from here from then on");
  const letGo = await until(() => !keptAs("-stuck.mp4").length && /stopped sending this file/.test(serverLog), 8000);
  check(letGo, "one that stops coming is let go of, with nothing half-kept");
  edit((s) => delete s.media.vid_stuck.stall); // it'll come whole next time

  // ---------- the gateway goes away, and comes back ----------
  await gw.down();
  const away = await until(async () => (await get("/api/openclaw")).state !== "connected", 5000);
  edit((s) => {
    const x = s.sessions.find((y) => y.key === MAIN);
    x.messages.push({ role: "user", content: "Book the train to Porto", timestamp: Date.now() }, { role: "assistant", content: [{ type: "text", text: "Booked." }], timestamp: Date.now() });
    x.updatedAt = Date.now();
  });
  await sleep(2500); // a try or two while it's gone, each refused
  const gone = (await state()).agents.find((a) => a.id === "openclaw-main");
  check(gone?.offline && gone.link?.state !== "connected" && gone.link.since && Date.parse(gone.link.since) < Date.now() - 2000, "meanwhile its agents are offline, saying since when");
  // What you write meanwhile can't get there (each try waits 15s for the gateway): it stays on the thread, saying
  // why, to send again or delete, rather than going with a reply saying it didn't.
  const thread = `/api/sessions/${encodeURIComponent(MAIN)}`;
  await post(`${thread}/messages`, { text: "Is the train on time?" });
  await post(`${thread}/messages`, { text: "Never mind the train" });
  const unsent = await until(async () => {
    const ms = (await get(thread)).messages || [];
    const a = ms.find((m) => m.text === "Is the train on time?");
    const b = ms.find((m) => m.text === "Never mind the train");
    return a?.failed && b?.failed && { a, b, ms };
  }, 40000);
  check(unsent && /^couldn't reach OpenClaw: /.test(unsent.a.failed.error) && !unsent.ms.some((m) => m.from !== "human" && /couldn't reach/.test(m.text)), "a message that can't reach OpenClaw stays on its thread as not delivered, saying why, instead of a reply that says so");
  await sleep(2500);
  check(!calls().some((c) => c.method === "chat.send" && /train/.test(c.params.message)) && (await get(thread)).messages.filter((m) => m.failed).length === 2, "and it isn't tried again by itself");
  await gw.up();
  // Gone this long, it tries every 30s, so that's how long the gateway can be back before it hears.
  const back = await until(async () => (await get("/api/openclaw")).state === "connected", 40000);
  const here = await until(async () => {
    const a = (await state()).agents.find((x) => x.id === "openclaw-main");
    return !a?.offline && a?.link?.state === "connected" && !a.link.since;
  });
  check(here, "and online again once it's back");
  const missed = await until(async () => (await get(thread)).messages?.find((m) => m.text === "Book the train to Porto"), 15000);
  check(away && back && missed, "when the gateway goes away for a while, agentbook connects again once it's back, and gets what it missed");
  const stuckKept = await until(() => keptAs("-stuck.mp4").length === 1 && !keptAs("-stuck.mp4")[0].endsWith(".part"), 10000);
  check(stuckKept && fs.readFileSync(path.join(HOME, "cli", "files", keptAs("-stuck.mp4")[0])).equals(STUCK), "and the video that stopped coming is asked for again, unopened, and kept");
  const retried = await post(`${thread}/messages/${encodeURIComponent(unsent?.a.id)}/retry`);
  const resent = await until(() => calls().find((c) => c.method === "chat.send" && c.params.message === "Is the train on time?"));
  const after = await until(async () => {
    const ms = (await get(thread)).messages || [];
    const a = ms.find((m) => m.id === unsent?.a.id);
    return a && !a.failed && ms.some((m) => m.text === "Got it: Is the train on time?") && ms;
  });
  check(retried.ok && resent && after?.find((m) => m.id === unsent.a.id).at > unsent.a.at && after.filter((m) => m.text === "Is the train on time?").length === 1, "Try again sends it, as of now, and the thread shows it once, with its reply");
  check((await post(`${thread}/messages/${encodeURIComponent(unsent?.a.id)}/retry`)).status === 409 && (await post(`${thread}/messages/${encodeURIComponent(unsent?.a.id)}/delete`)).status === 409, "a delivered message isn't sent again or deleted");
  const deleted = await post(`${thread}/messages/${encodeURIComponent(unsent?.b.id)}/delete`);
  await sleep(1500);
  check(deleted.ok && !(await get(thread)).messages.some((m) => m.text === "Never mind the train") && !calls().some((c) => c.method === "chat.send" && c.params.message === "Never mind the train"), "Delete takes one off the thread, unsent");

  // ---------- a connection that goes quiet ----------
  gw.freeze(true);
  const quiet = await until(async () => (await get("/api/openclaw")).state !== "connected", 5000);
  gw.freeze(false);
  const awake = await until(async () => (await get("/api/openclaw")).state === "connected", 15000);
  check(quiet && awake, "a connection that stops hearing the gateway's ticks is dropped, and made again");

  // ---------- its device token ----------
  // Meanwhile a reply agentbook copied before it kept media turns out to have had a picture.
  edit((s) => (s.sessions.find((y) => y.key === MAIN).messages[1].content as Part[]).push({ type: "image", artifactId: "img_route", alt: "Plan sketch", mimeType: "image/png" }));
  server.kill();
  await sleep(300);
  const c = JSON.parse(fs.readFileSync(saved, "utf8"));
  check(c.device?.deviceToken?.startsWith("dt-"), "the gateway's device token is kept");
  delete c.token; // as if the shared token were forgotten
  fs.writeFileSync(saved, JSON.stringify(c), { mode: 0o600 });
  const before = gw.connects.length;
  await startServer();
  const again = await until(async () => (await get("/api/openclaw")).state === "connected", 9000);
  check(again && gw.connects.slice(before).every((p) => p.auth?.token === c.device.deviceToken), "after a restart it reconnects with its device token alone");
  const asksBefore = gw.mediaAsks.length;
  const goneAgain = await req(`/api/files/${town.files[2].id}`);
  check(goneAgain.status === 404 && gw.mediaAsks.length === asksBefore + 1 && gw.mediaAsks.at(-1).auth === `Bearer ${c.device.deviceToken}`, "and asks for a file with its device token too");
  const sketched = await until(async () => {
    const d = await get(`/api/sessions/${encodeURIComponent(MAIN)}`);
    return d.messages?.some((m) => m.text === "Here's a plan." && m.files?.length) && d.messages.filter((m) => m.text === "Here's a plan.");
  });
  check(sketched?.length === 1 && sketched[0].files.map((f) => f.name).join() === "Plan sketch.png", "a message copied before agentbook kept media gets its picture, and isn't copied again");
  // Said less than a day ago, it's kept at once, unopened: OpenClaw deletes what its agents send a day after.
  const sketchKept = await until(() => fs.readdirSync(path.join(HOME, "cli", "files")).some((n) => n.endsWith("-Plan sketch.png")));
  check(sketchKept, "and, said less than a day ago, it's kept here at once, before OpenClaw deletes it");

  // ---------- turned away for a while ----------
  server.kill();
  await sleep(300);
  gw.limit(true);
  await startServer();
  const turned = await until(async () => {
    const o = await get("/api/openclaw");
    return o.state === "failed" && o;
  }, 9000);
  check(/turning this machine away/.test(turned?.error || "") && JSON.parse(fs.readFileSync(saved, "utf8")).device?.deviceToken === c.device.deviceToken, "turned away after too many failed sign-ins, it keeps its device token");
  server.kill();
  await sleep(300);
  gw.limit(false);
  await startServer();
  check(await until(async () => (await get("/api/openclaw")).state === "connected", 9000), "and connects with it once the gateway lets it in");

  // ---------- disconnecting ----------
  const off = await post("/api/openclaw", { disconnect: true });
  check(off.mode === "command" && !JSON.parse(fs.readFileSync(saved, "utf8")).url, "disconnecting forgets the gateway");

  // ---------- a setup code ----------
  const { deviceId } = JSON.parse(fs.readFileSync(saved, "utf8")).device;
  gw.forget(deviceId); // removed on the gateway too, so it pairs again
  const bad = await post("/api/openclaw", { setup_code: "not-a-setup-code" });
  const old = await post("/api/openclaw", { setup_code: gw.setupCode({ expiresAt: Date.now() - 1000 }).code });
  check(bad.status === 400 && /isn't an OpenClaw setup code/.test(bad.error) && old.status === 400 && /expired/.test(old.error), "it says when a setup code isn't one, or has expired");
  const used = gw.setupCode();
  gw.revoke(used.bootstrapToken);
  await post("/api/openclaw", { setup_code: used.code });
  const spent = await until(async () => {
    const o = await get("/api/openclaw");
    return o.state === "failed" && o;
  });
  check(spent?.auth === "setup-code" && /expired, or was already used/.test(spent.error), "a setup code the gateway won't take asks for a new one");
  const fresh = gw.setupCode();
  const set = await post("/api/openclaw", { setup_code: `oc-pair://${fresh.code}` });
  check(set.mode === "gateway" && set.url === gw.url && set.auth === "setup-code" && set.expiresAt > Date.now(), "a setup code (or its oc-pair:// link) is the gateway's address and a way in");
  const codePairing = await until(async () => {
    const o = await get("/api/openclaw");
    return o.state === "pairing" && o;
  });
  const codeHello = gw.connects.at(-1);
  check(codePairing?.requestId === gw.requests()[0] && codeHello.auth?.bootstrapToken === fresh.bootstrapToken && !codeHello.auth.token, "it signs in with the code's bootstrap token, and waits for approval");
  check(!(await raw("/api/openclaw")).includes(fresh.bootstrapToken) && !(await raw("/api/q/side") + (await raw("/api/q/feed"))).includes(fresh.bootstrapToken), "the code's token never comes back to the page");
  gw.approve(codePairing.requestId);
  const codeOk = await until(async () => {
    const o = await get("/api/openclaw");
    return o.state === "connected" && o;
  }, 9000);
  const kept = JSON.parse(fs.readFileSync(saved, "utf8"));
  check(codeOk?.auth === "device" && kept.device?.deviceToken && !kept.bootstrapToken && !kept.expiresAt, "once approved, it keeps the device token and drops the spent code");
  server.kill();
  await sleep(300);
  const before2 = gw.connects.length;
  await startServer();
  const again2 = await until(async () => (await get("/api/openclaw")).state === "connected", 9000);
  check(again2 && gw.connects.slice(before2).every((p) => p.auth?.token === kept.device.deviceToken && !p.auth.bootstrapToken), "and after a restart reconnects with that alone");

  // ---------- paired from the machine (agentbook-cli openclaw) ----------
  // The code goes to the machine's own agentbook-cli, on loopback: the server never sees it.
  // Not blocking this process meanwhile: the connections it keeps to agentbook stay good.
  const cli = (...a: string[]) => new Promise<{ status: number | string; stdout: string; stderr: string }>((resolve) => execFile(process.execPath, [path.join(ROOT, "cli", "main.mjs"), "openclaw", ...a], { env, encoding: "utf8", timeout: 20000 }, (err, stdout, stderr) => resolve({ status: err ? err.code ?? 1 : 0, stdout, stderr })));
  const forgot = await cli("off");
  check(forgot.status === 0 && /Forgot/.test(forgot.stdout) && (await get("/api/openclaw")).mode === "command", "agentbook-cli openclaw off forgets the gateway, on the machine");
  const onMachine = gw.setupCode();
  const paired = await cli("pair", onMachine.code);
  const hereOk = await until(async () => {
    const o = await get("/api/openclaw");
    return o.mode === "gateway" && o.url === gw.url && o.state === "connected" && o;
  }, 9000);
  check(paired.status === 0 && /OpenClaw: (connected to|waiting for you to approve)/.test(paired.stdout) && !!hereOk, `agentbook-cli openclaw pair <setup code> pairs this machine with the gateway (${paired.stdout.trim() || paired.stderr.trim()})`);
  const relayDb = new DatabaseSync(path.join(HOME, "storage.db"), { readOnly: true });
  const seen = (relayDb.prepare("select count(*) n from commands where args like ?").get(`%${onMachine.bootstrapToken}%`) as { n: number }).n + (relayDb.prepare("select count(*) n from relay_cache where data like ?").get(`%${onMachine.bootstrapToken}%`) as { n: number }).n;
  relayDb.close();
  check(seen === 0 && !(await raw("/api/q/side") + (await raw("/api/q/feed"))).includes(onMachine.bootstrapToken), "and its code never passes through the server");
  const relayAfter = new DatabaseSync(path.join(HOME, "storage.db"), { readOnly: true });
  const fromPage = relayAfter.prepare("select count(*) n from commands where kind = 'openclaw.pair'").get().n;
  relayAfter.close();
  check(fromPage === 0, "a setup code given on the page goes to the machine through the server, and the server keeps none of it");
  check(/OpenClaw: connected to/.test((await cli()).stdout), "agentbook-cli openclaw says how the machine reaches it");
} catch (e) {
  failures++;
  console.error(e);
} finally {
  server?.kill();
  gw.close();
}
if (failures) console.log(`\nserver log:\n${serverLog.slice(-3000)}`);
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
console.log(`(test data in ${HOME})`);
process.exit(failures ? 1 : 0);
