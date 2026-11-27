#!/usr/bin/env node
// A terminal on a thread: its owner opens a shell in the thread's folder, on its machine, and types in it from the
// page, on the terminal's own WebSocket; what it shows comes back as it shows it, and a page that opens it again gets
// what it showed lately. It's the thread's until its person closes it or its shell exits: the server restarting,
// agentbook-cli restarting, or its person signing out leave it be. Nobody else can open it, see it or type in it,
// and no other site can reach its socket. The machine's gate opens it only in the thread's own folder (never one the
// server names, nor one it keeps out), and can turn terminals off. Its shell doesn't get agentbook's own keys.
// Run: node test/terminal.ts

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "./harness-sql.ts";
import { socketsDir } from "../plugin/cli/terminals.ts";
import { createTyping } from "../web/lib/typing.ts";
import { spawnAgentbook, testPort } from "./harness.ts";
import type { Json } from "./harness-types.ts";

const TEST = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST, "..", "plugin");
const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-terminal-")));
const PORT = testPort(5200);
const URL = `http://127.0.0.1:${PORT}`;
const WS = URL.replace(/^http/, "ws");
const env = {
  ...process.env,
  AGENTBOOK_HOME: HOME,
  HOME,
  AGENTBOOK_PORT: String(PORT),
  AGENTBOOK_URL: URL,
  AGENTBOOK_CODEX: "0",
  AGENTBOOK_OPENCLAW: "0",
  AGENTBOOK_TERMINAL: "0",
  AGENTBOOK_CLAUDE: path.join(TEST, "fake-claude.ts"),
  CLAUDE_CONFIG_DIR: path.join(HOME, "claude"),
  CLAUDE_PLUGIN_ROOT: ROOT,
  CLAUDE_CODE_ENTRYPOINT: "cli",
  SHELL: "/bin/sh",
  // A shell keeps its own history, as in any terminal, and only sometimes gets it written as it's hung up. What's
  // checked below is that agentbook keeps nothing of what's typed, so this one has no history file to be caught by.
  HISTFILE: "",
  AGENTBOOK_TERM_PROBE: "agentbook's own",
};
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_OWNER", "AGENTBOOK_LAUNCH_ID"]) delete env[k];
const project = path.join(HOME, "dev", "app");
const other = path.join(HOME, "dev", "secret");
fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(other, { recursive: true });

let failures = 0;
const check = (cond: unknown, label: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const until = async <T>(fn: () => T | Promise<T>, ms = 8000) => {
  for (const end = Date.now() + ms; ; await sleep(50)) {
    const v = await fn();
    if (v || Date.now() > end) return v;
  }
};
const as = (cookie: string) => {
  const call = async (method: string, p: string, body?: unknown): Promise<Json> => {
    const r = await fetch(URL + p, { method, headers: { cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data: Json = await r.json().catch(() => ({}));
    return { status: r.status, ...data };
  };
  return { cookie, get: (p: string) => call("GET", p), post: (p: string, body: unknown = {}) => call("POST", p, body) };
};
// Each of a Claude Code process's hooks says which session it's in, as Claude Code's do.
const sessionOf: Record<number, string> = {};
const hook = (event: string, input: { session_id?: string; [field: string]: unknown }, pid: number) => {
  if (input.session_id) sessionOf[pid] = input.session_id;
  return spawnSync(process.execPath, [path.join(ROOT, "hooks", "hook.ts"), event], { input: JSON.stringify({ cwd: project, session_id: sessionOf[pid], ...input }), env: { ...env, AGENTBOOK_PID: String(pid) }, encoding: "utf8", timeout: 15000 });
};
const alive = (p: number) => {
  try {
    process.kill(p, 0);
    return true;
  } catch {
    return false;
  }
};

// A page's side of what's typed (web/lib/typing.ts): `type` it, its socket `open` (and whether its terminal says
// what its shell `got`), `closed`, and whether it `says` what it got.
interface Typing {
  type(data: string): void;
  open(saysGot: boolean): void;
  got(id: string): void;
  closed(): void;
  says(acks: boolean): void;
}
// A terminal's socket, as a page has it: what it says, all it showed (as text), and how it closed. `ended`: its
// "end" message; `epoch` and `seq`: where what it showed is up to, for `from`.
interface Watch {
  ws: WebSocket;
  events: Json[];
  text: string;
  ended: Json;
  closed: number | null;
  epoch: string | null;
  seq: number;
  hello: () => Promise<unknown>;
  type: (data: string) => void;
  size: (cols: number, rows: number) => void;
  saw: (s: string, ms?: number) => Promise<boolean>;
  at: () => string;
  stop: () => void;
}
function watch(who: { cookie: string }, tid: string, { from = null, origin = URL, typing = null }: { from?: string | null; origin?: string; typing?: Typing | null } = {}): Watch {
  const w: Watch = {
    ws: new WebSocket(`${WS}/api/terminals/${tid}/ws${from ? `?from=${encodeURIComponent(from)}` : ""}`, { headers: { cookie: who.cookie, origin } }),
    events: [],
    text: "",
    ended: null,
    closed: null,
    epoch: null,
    seq: 0,
    hello: () => until(() => w.events.some((e) => e.t === "hello") || w.closed),
    type: (data) => w.ws.send(JSON.stringify({ t: "in", data })),
    size: (cols, rows) => w.ws.send(JSON.stringify({ t: "size", cols, rows })),
    saw: (s, ms = 8000) => until(() => w.text.includes(s), ms),
    at: () => `${w.epoch}:${w.seq}`,
    stop: () => w.ws.close(),
  };
  w.ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    w.events.push(m);
    if (m.t === "hello" || m.t === "reset") w.epoch = m.epoch;
    if (m.t === "hello") typing?.open(!!m.acks);
    if (m.t === "got") typing?.got(m.id);
    if (m.t === "line" && m.up) typing?.says(!!m.acks);
    if (m.t === "out") {
      w.text += Buffer.from(m.data, "base64").toString("utf8");
      w.seq = m.seq;
    }
    if (m.t === "end") w.ended = m;
  };
  // Node's WebSocket says only "error" when the server turns it down (a browser closes it, 1006).
  w.ws.onerror = () => w.ws.readyState !== WebSocket.OPEN && (w.closed ??= 1006);
  w.ws.onclose = (e) => {
    w.closed = e.code;
    typing?.closed();
  };
  return w;
}
// The holders this test started (their shells outlive agentbook-cli, by design): gone at the end.
function killHolders() {
  const dir = socketsDir(path.join(HOME, "cli"));
  const ps = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).stdout || "";
  for (const line of ps.split("\n")) if (line.includes(dir)) process.kill(Number(line.trim().split(/\s+/)[0]), "SIGTERM");
  fs.rmSync(dir, { recursive: true, force: true });
}

const server = spawnAgentbook({ env, stdio: process.env.DEBUG ? "inherit" : "ignore" });
const watchers: Watch[] = [];
try {
  await until(async () => (await fetch(URL + "/api/health").catch(() => null))?.ok, 10000);
  const setup = await fetch(URL + "/api/auth/test-person", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "tester" }) });
  const me = as((setup.headers.get("set-cookie") || "").split(";")[0]);
  const signup = await fetch(URL + "/api/auth/test-person", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "alice" }) });
  const alice = as((signup.headers.get("set-cookie") || "").split(";")[0]);

  hook("SessionStart", { session_id: "term-1", source: "startup" }, 7101);
  hook("UserPromptSubmit", { prompt: "Work on the app" }, 7101);
  const thread = await until(async () => {
    const r = await me.get("/api/sessions/term-1");
    return r.status === 200 && r;
  });
  check(!!thread, "a thread working in ~/dev/app");
  // Its owner's contacts may see it (it's public), but not open its terminal.
  await alice.post("/api/people/tester/contact", { act: "ask" });
  await me.post("/api/people/alice/contact", { act: "yes" });
  await me.post("/api/sessions/term-1/visibility", { visibility: "public" });

  // ---------- its owner opens one, in its folder ----------
  const none = await me.get("/api/sessions/term-1/terminal");
  check(none.status === 200 && none.terminal === null, "a thread has no terminal open to start with");
  const opening = me.post("/api/sessions/term-1/terminal", { cols: 100, rows: 30 });
  // While it opens, nothing says it's waiting for the machine: it's not a command to take back later.
  let listed = false;
  for (let i = 0; i < 5; i++) listed ||= ((await me.get("/api/sessions/term-1")).waiting || []).length > 0;
  const opened = await opening;
  const T = opened.terminal;
  check(!listed, "while it opens, the thread doesn't list it as waiting for its machine");
  check(opened.status === 200 && T?.state === "open" && T.cwd === project && T.shell === "sh", `its owner opens a terminal, a shell in the thread's folder on its machine (${opened.status} ${opened.error || ""})`);
  const again = await me.post("/api/sessions/term-1/terminal", { cols: 100, rows: 30 });
  check(again.terminal?.id === T?.id && (await me.get("/api/sessions/term-1/terminal")).terminal?.id === T?.id, "opening it again, or asking which is open, is the same terminal");

  const w = watch(me, T.id);
  watchers.push(w);
  check(!!(await w.hello()) && !w.closed, "the page watches what it shows, on its own socket");
  w.type('echo "ab-$((6*7))"; pwd; stty size\n');
  check(!!(await w.saw("ab-42")), "what's typed runs in the shell, and what it shows comes back");
  check(!!(await w.saw(project)) && !!(await w.saw("30 100")), "in the thread's folder, at the page's size");
  w.size(120, 40);
  w.type("stty size\n");
  check(!!(await w.saw("40 120")), "resizing it resizes the shell's terminal");
  w.type('echo "probe=[${AGENTBOOK_TERM_PROBE}] term=$TERM"\n');
  check(!!(await w.saw("probe=[] term=xterm-256color")), "its shell has none of agentbook's own settings, and says it's an xterm");

  // A page that opens it again gets what it showed lately, and what it shows from then on.
  const w2 = watch(me, T.id);
  watchers.push(w2);
  check(!!(await w2.saw("ab-42", 4000)) && w2.events.some((e) => e.t === "reset"), "a page opening it again gets what it showed lately");
  const w3 = watch(me, T.id, { from: w.at() });
  watchers.push(w3);
  await w3.hello();
  w.type("echo after-$((1+1))\n");
  check(!!(await w.saw("after-2")) && !!(await w2.saw("after-2")) && !!(await w3.saw("after-2")) && !w3.text.includes("ab-42"), "every page watching sees what comes next; one that says what it saw last gets only what's after");

  // ---------- nobody else ----------
  const theirs = await alice.post("/api/sessions/term-1/terminal", { cols: 80, rows: 24 });
  check(theirs.status === 403 && (await alice.get("/api/sessions/term-1/terminal")).status === 403, `someone else who sees the thread can't open its terminal, or ask about it (${theirs.status})`);
  const peek = watch(alice, T.id);
  await until(() => peek.closed);
  const closedByThem = await alice.post(`/api/terminals/${T.id}/close`);
  check(peek.closed === 4404 && !peek.text && closedByThem.status === 404, `nor watch it, type in it or close it, knowing its id (${peek.closed})`);
  const elsewhere = watch(me, T.id, { origin: "https://evil.example" });
  await until(() => elsewhere.closed);
  check(elsewhere.closed && !elsewhere.events.length, "nor can another site reach its socket with its person's sign-in");
  const device = JSON.parse(fs.readFileSync(path.join(HOME, "cli", "device.json"), "utf8"));
  const fake = new WebSocket(`${device.server.replace(/^http/, "ws")}/api/cli/terminals/ws`, { headers: { authorization: "Bearer not-a-machine" } });
  let fakeOpen = false;
  let fakeRefused = false;
  fake.onopen = () => (fakeOpen = true);
  fake.onerror = () => (fakeRefused = true);
  check((await until(() => fakeRefused, 4000)) && !fakeOpen, "nor can anything but its machine connect as its machine");

  // ---------- it stays: the server restarting, agentbook-cli restarting, signing out ----------
  w.type("echo $$ > shell.pid\n");
  const pidFile = path.join(project, "shell.pid");
  const pid = Number(await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").trim()));
  check(pid > 0 && alive(pid), "its shell is a process on the machine");
  // Seen through to the shell: what's still on its way as the server stops goes with it.
  w.type("export KEPT=yes-$((3*3)); echo set-$KEPT\n");
  await w.saw("set-yes-9");
  for (const x of [w2, w3]) x.stop();

  await server.restart("agentbook-server");
  const back = await until(async () => (await me.get("/api/sessions/term-1/terminal")).terminal, 10000);
  check(back?.id === T.id && back.state === "open" && alive(pid), "after the server restarts, the thread's terminal is the same one, its shell still going");
  const w4 = watch(me, T.id, { from: w.at() });
  watchers.push(w4);
  check(!!(await w4.saw("after-2", 6000)) && w4.events.some((e) => e.t === "reset"), "and a page gets what it showed lately again, from its machine");
  w4.type("echo still-$KEPT\n");
  check(!!(await w4.saw("still-yes-9")), "and what's typed reaches the same shell");

  await server.restart("agentbook-cli");
  check(alive(pid), "agentbook-cli restarting leaves its shell be");
  await until(async () => {
    const x = watch(me, T.id);
    const ok = !!(await x.hello()) && !x.closed;
    x.stop();
    return ok;
  }, 15000);
  const w5 = watch(me, T.id);
  watchers.push(w5);
  await w5.hello();
  w5.type("echo again-$KEPT\n");
  check(!!(await w5.saw("again-yes-9", 10000)), "and once it's back, the page types in the same shell");

  // A process that's killed sends no goodbye, so the server has to see for itself that the line went, and tells the page.
  // Until it does, what's typed goes down that line and is gone, in place of waiting for the machine.
  const told = w5.events.length;
  const stopped = server.restart("agentbook-cli");
  check(!!(await until(() => w5.events.slice(told).some((e) => e.t === "line" && !e.up), 10000)), "the page hears at once when agentbook-cli's line goes");
  w5.type("echo waited-$KEPT\n");
  await stopped;
  check(!!(await w5.saw("waited-yes-9", 10000)), "what's typed while agentbook-cli is down waits for it, and reaches the same shell");

  const second = as((await fetch(URL + "/api/auth/test-person", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "tester" }) })).headers.get("set-cookie").split(";")[0]);
  const w6 = watch(second, T.id);
  watchers.push(w6);
  await w6.hello();
  await second.post("/api/auth/logout");
  check(!!(await until(() => w6.closed === 4401)) && !w5.closed, "signing out takes it off that sign-in's pages, not others'");
  check(alive(pid) && (await me.get("/api/sessions/term-1/terminal")).terminal?.id === T.id, "and its shell goes on");

  // ---------- closing it hangs its shell up ----------
  await me.post(`/api/terminals/${T.id}/close`);
  check(!!(await until(() => w5.ended)) && /closed/.test(w5.ended.why), "closing it ends it on every page watching");
  check(!!(await until(() => !alive(pid), 8000)), "and its shell is gone");
  check((await me.get("/api/sessions/term-1/terminal")).terminal === null, "and the thread has no terminal open");

  // ---------- its shell exiting ends it ----------
  const T2 = (await me.post("/api/sessions/term-1/terminal", { cols: 80, rows: 24 })).terminal;
  const w7 = watch(me, T2.id);
  watchers.push(w7);
  await w7.hello();
  check(T2?.id && T2.id !== T.id, "a new one opens after");
  w7.type("exit 7\n");
  check(!!(await until(() => w7.ended)) && w7.ended.code === 7 && /exited/.test(w7.ended.why), "a shell that exits ends its terminal, with its code");

  // ---------- what's on its way as a side stops ----------
  // Whatever stops, a piece reaches the shell once: the page and the server keep it until the shell has it, and send it
  // again; the shell's holder, which outlives them, takes an id once. typed.log says how many times each ran.
  const T3 = (await me.post("/api/sessions/term-1/terminal", { cols: 80, rows: 24 })).terminal;
  const ran = (s: string) => {
    try {
      return fs.readFileSync(path.join(project, "typed.log"), "utf8").split("\n").filter((l) => l === s).length;
    } catch {
      return 0;
    }
  };
  let p: Watch | null = null;
  const typing: Typing = createTyping((m: object) => p?.ws.readyState === WebSocket.OPEN && (p.ws.send(JSON.stringify(m)), true));
  const onPage = async () => {
    p = watch(me, T3.id, { typing });
    watchers.push(p);
    await p.hello();
  };
  await onPage();
  check(p.events.find((e) => e.t === "hello")?.acks === true, "a terminal says it says what its shell got");
  typing.type("echo one >> typed.log\n");
  await until(() => p.events.some((e) => e.t === "got"));
  const twice = { t: "in", id: p.events.find((e) => e.t === "got").id, data: "echo one >> typed.log\n" };
  p.ws.send(JSON.stringify(twice));
  typing.type("echo two >> typed.log\n");
  check(!!(await until(() => ran("two"))) && ran("one") === 1, "what comes again under the same id runs once");

  const instants = [0, 2, 5, 10, 20];
  const stopsCli = [];
  for (const ms of instants) {
    const stopped = server.restart("agentbook-cli");
    await sleep(ms);
    typing.type(`echo cli-${ms} >> typed.log\n`);
    await stopped;
    await until(() => ran(`cli-${ms}`), 10000);
    stopsCli.push(ran(`cli-${ms}`));
  }
  check(stopsCli.every((n) => n === 1), `what's typed just as agentbook-cli stops reaches the shell once (${stopsCli})`);

  const stopsServer = [];
  for (const ms of instants) {
    const stopped = server.restart("agentbook-server");
    await sleep(ms);
    typing.type(`echo server-${ms} >> typed.log\n`);
    await stopped;
    await until(async () => (await me.get("/api/sessions/term-1/terminal")).terminal, 10000);
    await onPage();
    await until(() => ran(`server-${ms}`), 10000);
    stopsServer.push(ran(`server-${ms}`));
  }
  check(stopsServer.every((n) => n === 1), `what's typed just as the server stops reaches the shell once, from the page, once it's back (${stopsServer})`);
  await me.post(`/api/terminals/${T3.id}/close`);
  await until(async () => (await me.get("/api/sessions/term-1/terminal")).terminal === null);

  // A shell from before this version outlives agentbook-cli updating, so its holder knows nothing of ids: it hears
  // what's typed plainly, once, and nothing goes again.
  const local = String(T3.post).split(":").pop();
  const oldTid = `t${"o".repeat(20)}`;
  const heard = [];
  const frames = (kind, body) => {
    const head = Buffer.alloc(5);
    head.write(kind, 0, "latin1");
    head.writeUInt32BE(Buffer.byteLength(body), 1);
    return Buffer.concat([head, Buffer.from(body)]);
  };
  const oldHolder = net.createServer((c) => {
    let buf = Buffer.alloc(0);
    c.write(frames("M", JSON.stringify({ tid: oldTid, post: local, cwd: project, shell: "sh", marks: false, v: 1, pid: 1, cols: 80, rows: 24 })));
    c.write(frames("R", ""));
    c.on("error", () => {});
    c.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 5 && buf.length >= 5 + buf.readUInt32BE(1)) {
        const n = buf.readUInt32BE(1);
        heard.push({ kind: String.fromCharCode(buf[0]), text: buf.subarray(5, 5 + n).toString() });
        buf = buf.subarray(5 + n);
      }
      if (heard.some((f) => f.kind === "C")) {
        c.destroy();
        oldHolder.close();
      }
    });
  });
  const oldSock = path.join(socketsDir(path.join(HOME, "cli")), `${oldTid}.sock`);
  await new Promise<void>((r) => oldHolder.listen(oldSock, r));
  await server.restart("agentbook-cli");
  const found = await until(async () => {
    const t = (await me.get("/api/sessions/term-1/terminal")).terminal;
    return t?.id === oldTid && t;
  }, 10000);
  check(found?.acks === false, "a shell from before this says it can't say what it got");
  const oldTyping: Typing = createTyping((m: object) => p?.ws.readyState === WebSocket.OPEN && (p.ws.send(JSON.stringify(m)), true));
  p = watch(me, oldTid, { typing: oldTyping });
  watchers.push(p);
  await p.hello();
  oldTyping.type("plain\n");
  await until(() => heard.some((f) => f.kind === "I"));
  check(heard.filter((f) => f.kind === "I" && f.text === "plain\n").length === 1 && !heard.some((f) => f.kind === "T"), "and it hears what's typed as it always has");
  await server.restart("agentbook-cli");
  await until(() => p.events.filter((e) => e.t === "line" && e.up).length, 10000);
  await sleep(200);
  check(heard.filter((f) => f.text === "plain\n").length === 1, "and hears it once: nothing goes again, which would type it twice");
  await me.post(`/api/terminals/${oldTid}/close`);
  await until(async () => (await me.get("/api/sessions/term-1/terminal")).terminal === null);

  // ---------- the machine's gate ----------
  // Only the thread's own folder: one the machine keeps out stays out.
  const gateFile = path.join(HOME, "cli", "gate.json");
  const gate = JSON.parse(fs.readFileSync(gateFile, "utf8"));
  fs.writeFileSync(gateFile, JSON.stringify({ ...gate, never: [project] }));
  const kept = await me.post("/api/sessions/term-1/terminal", { cols: 80, rows: 24 });
  check(kept.status === 403 && /keeps out/.test(kept.error || ""), `a folder the machine keeps out gets no terminal (${kept.error})`);
  fs.writeFileSync(gateFile, JSON.stringify({ ...gate, commands: { ...(gate.commands || {}), term: false } }));
  const off = await me.post("/api/sessions/term-1/terminal", { cols: 80, rows: 24 });
  check(off.status === 403 && /turned off term/.test(off.error || ""), `a machine can turn terminals off in its gate.json (${off.error})`);
  fs.writeFileSync(gateFile, JSON.stringify(gate));
  const log = fs.readFileSync(path.join(HOME, "cli", "audit.jsonl"), "utf8").split("\n").slice(0, -1).map((l) => JSON.parse(l)).filter((l) => l.kind === "term.open");
  check(log.some((l) => l.outcome === "ran" && l.by === "tester") && log.filter((l) => l.outcome === "refused").length >= 2, "the gate's log has each terminal opened, and each refused");
  // More time to type: with its server on this machine it isn't needed, but the route and the command work.
  const leasing = await me.post("/api/sessions/term-1/terminal", { cols: 80, rows: 24 });
  const leased = await me.post(`/api/terminals/${leasing.terminal?.id}/lease`, {});
  check(leased.status === 200 || leased.ok === true, `a person can renew a terminal of theirs (${JSON.stringify(leased).slice(0, 120)})`);
  check((await me.post("/api/terminals/t-not-mine/lease", {})).status === 404, "but not one that isn't");
  // Typing never goes in a database or a log, on the server or the machine.
  const files = (dir) => fs.readdirSync(dir, { recursive: true }).map((f) => path.join(dir, f)).filter((f) => fs.statSync(f).isFile() && !f.startsWith(path.join(HOME, "dev")));
  const typedIn = files(HOME).filter((f) => ["after-$((1+1))", ">> typed.log"].some((s) => fs.readFileSync(f).includes(s)));
  check(!typedIn.length, `what's typed in it isn't kept anywhere (${typedIn.join(", ")})`);
  const relayDb = new DatabaseSync(path.join(HOME, "storage.db"));
  check(relayDb.prepare("select count(*) n from commands where kind = 'term.open'").get().n === 0, "nor are the terminals opened: the server holds them in memory only");
  relayDb.close();
} catch (e) {
  check(false, `crashed: ${e.stack}`);
} finally {
  for (const w of watchers) w.stop();
  server.kill();
  await sleep(300);
  killHolders();
  fs.rmSync(HOME, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
