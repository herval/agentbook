#!/usr/bin/env node
// The address a test talks to (see harness.ts), in a process of its own: agentbook-server and agentbook-cli under
// it, and the test's one address in front of them. It stops them when it's told to (with the signal it's given,
// over its IPC channel), when either stops on its own, and when the test is gone.
// Run by harness.ts: node test/harness-front.ts '{"root", "people"}', with agentbook's environment.
// AGENTBOOK_HARNESS_ONE=1 runs both halves as one process, as `agentbook webui` does (plugin/cli/webui.ts): the
// CLI's daemon with --webui, serving the page on the server's port, and logging itself in to it at the first account.

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { isSessionRoute } from "../plugin/cli/daemon.ts";
import { type Half, machineOnly as isMachineOnly } from "./harness.ts";
import { STRIPPED } from "./harness-strip.ts";
import type { CliStatus } from "./harness-types.ts";

const { root, people: TEST_PEOPLE } = JSON.parse(process.argv[2]);
const env = { ...process.env };
const port = Number(env.AGENTBOOK_PORT || 4320);
const home = env.AGENTBOOK_HOME || path.join(os.homedir(), ".agentbook");
// A machine logged in to agentbook elsewhere (as agentbook-cli login leaves it): only its CLI runs.
const ONE = env.AGENTBOOK_HARNESS_ONE === "1";
const machineOnly = isMachineOnly(env);
const serverHome = env.AGENTBOOK_SERVER_HOME || path.join(home, "server");
// The halves' own ports, as harness.ts picked them (halves()).
const serverPort = Number(env.AGENTBOOK_HARNESS_SERVER_PORT);
const cliPort = machineOnly ? port : Number(env.AGENTBOOK_HARNESS_CLI_PORT);
if (!serverPort || !cliPort) throw new Error("harness-front.ts is started by harness.ts's spawnAgentbook(), which gives it its halves' ports");
for (const k of ["AGENTBOOK_HARNESS_SERVER_PORT", "AGENTBOOK_HARNESS_CLI_PORT"]) delete env[k];
const ADDRESS = `http://127.0.0.1:${port}`;
const serverUrl = `http://127.0.0.1:${serverPort}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const say = (s: string) => process.stderr.write(`harness: ${s}\n`);

/* ---------- the two halves ---------- */

// A half running: its name ("agentbook" for both as one), and how to start it again.
type Child = ChildProcess & { name: string; args: string[]; more: NodeJS.ProcessEnv; restarting?: boolean };
const children: Child[] = [];

// The page built (build.ts --web) into the system's temp folder, named by when web/ and the code it shares last
// changed: made by the first test that needs it, and used by the rest. Always from this checkout: a test's copy of
// it (test/plugin-copy.ts) has the same page, and may not have build.ts.
function builtWeb(from = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")): string {
  const newest = (dir: string): number => fs.readdirSync(dir, { withFileTypes: true }).reduce((n, e) => (e.name === "node_modules" ? n : Math.max(n, e.isDirectory() ? newest(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).mtimeMs)), 0);
  const at = Math.round(Math.max(newest(path.join(from, "web")), newest(path.join(from, "plugin", "shared"))));
  const dir = path.join(fs.realpathSync(os.tmpdir()), `agentbook-test-web-${at}`);
  if (fs.existsSync(path.join(dir, "index.html"))) return dir;
  const tmp = `${dir}.${process.pid}`;
  const r = spawnSync(process.execPath, [path.join(from, "build.ts"), "--web", tmp], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`couldn't build the page: ${r.stderr}`);
  try {
    fs.renameSync(tmp, dir);
  } catch {
    fs.rmSync(tmp, { recursive: true, force: true }); // another test made it first
  }
  return dir;
}

// The plugin, agentbook-cli and their manifests as server/cli-bundle.ts hands them out, packed once into the system's
// temp folder for each copy of agentbook as its files are (a folder's time changes with what's added or taken out of
// it), as the page is, and copied into each server's data. Packing it at every start was a quarter of one.
const BUNDLED = [".claude-plugin", "plugin", "bin/agentbook-cli", "package.json"];
function builtBundle(): string | null {
  const newest = (p: string): number => {
    const st = fs.statSync(p);
    return st.isDirectory() ? fs.readdirSync(p).reduce((n, e) => (e === "node_modules" || e === ".DS_Store" ? n : Math.max(n, newest(path.join(p, e)))), st.mtimeMs) : st.mtimeMs;
  };
  try {
    const at = Math.round(Math.max(...BUNDLED.map((p) => newest(path.join(root, p)))));
    const key = crypto.createHash("sha1").update(`${fs.realpathSync(root)}\n${at}`).digest("hex").slice(0, 16);
    const file = path.join(fs.realpathSync(os.tmpdir()), `agentbook-test-cli-bundle-${key}.tgz`);
    if (fs.existsSync(file)) return file;
    const tmp = `${file}.${process.pid}`;
    if (spawnSync("tar", ["-czf", tmp, "--exclude", ".DS_Store", "--exclude", "node_modules", ...BUNDLED], { cwd: root }).status !== 0) {
      fs.rmSync(tmp, { force: true });
      return null;
    }
    fs.renameSync(tmp, file);
    return file;
  } catch {
    return null; // a copy without one of them, as tar would have refused it
  }
}
// What the halves load their code with (harness-strip.ts), by its real path, as the server's permissions go by it.
const STRIP = fs.realpathSync(path.join(path.dirname(new URL(import.meta.url).pathname), "harness-strip.ts"));

let stopping = false;
function run(args: string[], more: NodeJS.ProcessEnv, name: string) {
  const spawned = spawn(process.execPath, args, { env: more, stdio: ["ignore", "pipe", "pipe"] });
  spawned.stdout.pipe(process.stdout, { end: false });
  spawned.stderr.pipe(process.stderr, { end: false });
  const child: Child = Object.assign(spawned, { name, args, more });
  children.push(child);
  child.on("exit", (code, signal) => {
    if (stopping || child.restarting) return;
    // One stopping on its own stops the other: the test sees agentbook stop.
    say(`${name} exited (${code ?? signal})`);
    stop("SIGTERM", 1);
  });
}
async function stop(signal: NodeJS.Signals = "SIGTERM", code = 0) {
  if (stopping) return;
  stopping = true;
  front?.close();
  for (const s of sockets) s.destroy();
  await Promise.all(children.map((c) => (c.exitCode !== null || c.signalCode ? null : new Promise((r) => (c.once("exit", r), c.kill(signal))))));
  process.exit(signal === "SIGKILL" ? 137 : code);
}
// A test restarts one half ({ restart: "agentbook-server" or "agentbook-cli" }), as `agentbook stop` and `up` would,
// and hears back once it answers again.
const up = async (p: number) => (await fetch(`http://127.0.0.1:${p}/api/health`, { signal: AbortSignal.timeout(1000) }).catch(() => null))?.ok;
async function restart(name: Half) {
  const old = children.find((c) => (ONE && !machineOnly ? c.name === "agentbook" : c.name === name) && c.exitCode === null && !c.signalCode);
  if (!old || stopping) return;
  old.restarting = true;
  await new Promise((r) => (old.once("exit", r), old.kill("SIGTERM")));
  children.splice(children.indexOf(old), 1);
  const ports = old.name === "agentbook" ? [serverPort, cliPort] : [name === "agentbook-server" ? serverPort : cliPort];
  for (const p of ports) await free(p);
  run(old.args, old.more, old.name);
  for (let i = 0; i < 300 && !stopping && !(await Promise.all(ports.map(up))).every(Boolean); i++) await sleep(50);
}
process.on("message", (message) => {
  const m = message as { kill?: NodeJS.Signals; restart?: Half } | null;
  if (m?.kill) stop(m.kill);
  else if (m?.restart) restart(m.restart).then(() => process.send?.({ restarted: m.restart }));
});
process.on("disconnect", () => stop("SIGTERM"));
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => stop(sig));

// A port the last agentbook here still holds, until it lets go.
async function free(p: number) {
  for (let i = 0; i < 200; i++) {
    const ok = await new Promise((resolve) => {
      const s = net.createServer().once("error", () => resolve(false)).once("listening", () => s.close(() => resolve(true)));
      s.listen(p, "127.0.0.1");
    });
    if (ok) return;
    await sleep(50);
  }
  say(`port ${p} stayed in use`);
}

/* ---------- logging the CLI in, and waiting for it ---------- */

// The first account, made through here: the CLI logs in to the server as it, before the test hears back. As one
// process, it logs itself in (webui.ts): this waits for that.
async function linkCli(cookie: string) {
  if (ONE) {
    for (let i = 0; i < 200; i++) {
      const st = await status();
      if (st?.server && st.connected && !st.waiting) return;
      await sleep(50);
    }
    return say("the CLI didn't log itself in");
  }
  // What the server answers as a machine logs in: its code to approve, then its token (server/api/people.ts's /api/devices).
  interface Device {
    code?: string;
    poll?: string;
    token?: string;
    name?: string;
    user?: string;
  }
  const call = async (method: string, route: string, body?: object, headers: Record<string, string> = {}): Promise<Device> => {
    const r = await fetch(serverUrl + route, { method, headers: { "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
    return (r.json() as Promise<Device>).catch(() => ({}));
  };
  const name = env.AGENTBOOK_MACHINE || os.hostname().split(".")[0];
  const req = await call("POST", "/api/devices/start", { name });
  await call("POST", "/api/devices/approve", { code: req.code }, { cookie });
  const got = await call("GET", `/api/devices/poll?poll=${encodeURIComponent(req.poll)}`);
  if (!got.token) throw new Error(`the CLI couldn't log in: ${JSON.stringify(got)}`);
  fs.mkdirSync(path.join(home, "cli"), { recursive: true });
  fs.writeFileSync(path.join(home, "cli", "device.json"), JSON.stringify({ server: serverUrl, token: got.token, name: got.name, user: got.user, harness: true }), { mode: 0o600 });
  for (let i = 0; i < 100; i++) {
    const st = await status();
    if (st?.server && st.connected && !st.waiting) return;
    await sleep(50);
  }
  say("the CLI didn't connect");
}
const status = (): Promise<CliStatus | null> => fetch(`http://127.0.0.1:${cliPort}/api/status`).then((r) => r.json() as Promise<CliStatus>).catch(() => null);
// Connected to its server with nothing left to send (or not logged in at all).
async function linked() {
  const st = await status();
  return !!st && (!st.server || (st.connected && !st.waiting));
}
// Until the CLI has sent up what it had by now (when it's logged in), for a moment at most.
async function sent() {
  const first = await status();
  if (!first?.server) return;
  for (let i = 0; i < 60; i++) {
    const st = i ? await status() : first;
    if (!st || st.scanned >= first.seq) return;
    await sleep(20);
  }
}

/* ---------- the one address ---------- */

// A session's routes to the CLI, the page's to the server. The CLI checks it's addressed by its own name (so a
// foreign Host still is one); the server checks a change comes from its own page.
const ownHost = (h: string) => [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(h);
function proxy(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url, "http://x");
  const toCli = isSessionRoute(req.method, url.pathname);
  const target = toCli ? cliPort : serverPort;
  const headers = { ...req.headers };
  if (toCli) {
    if (ownHost(headers.host)) headers.host = headers.host.replace(`:${port}`, `:${cliPort}`);
    if (headers.origin && ownHost(headers.origin.replace(/^https?:\/\//, ""))) headers.origin = headers.origin.replace(`:${port}`, `:${cliPort}`);
  }
  // A browser signing in to a demo (test/demo.ts prints the link): as the tests make people, then to the page.
  if (!toCli && req.method === "GET" && url.pathname === "/test-sign-in") return signInBrowser(url.searchParams.get("as") || "", res);
  // People, as the tests make them (server/api/test-people.ts): the secret goes with it, and at the first one, the
  // page's person, the CLI logs in before the test hears back.
  const isPerson = !toCli && req.method === "POST" && url.pathname === "/api/auth/test-person";
  const whole = async (r: AsyncIterable<Buffer>) => {
    const chunks: Buffer[] = [];
    for await (const c of r) chunks.push(c);
    return Buffer.concat(chunks);
  };
  const forward = (body?: string) => {
    if (body !== undefined) headers["content-length"] = String(Buffer.byteLength(body));
    const up = http.request({ host: "127.0.0.1", port: target, method: req.method, path: req.url, headers, agent: false }, async (r) => {
      // What a session changed reaches the server a moment later: the test hears back once it has.
      if (toCli && req.method !== "GET") {
        const data = await whole(r);
        await sent();
        res.writeHead(r.statusCode, r.headers);
        return res.end(data);
      }
      if (isPerson && r.statusCode === 200) {
        const data = await whole(r);
        let first = false;
        try {
          first = JSON.parse(data.toString()).first === true;
        } catch {}
        if (first) await linkCli(String(r.headers["set-cookie"] || "").split(";")[0]).catch((e) => say(e.message));
        res.writeHead(r.statusCode, r.headers);
        return res.end(data);
      }
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "agentbook isn't up" }));
    });
    // A client that goes (a machine that stopped, mid long-poll) closes its way through, as it would directly.
    res.on("close", () => {
      if (!res.writableFinished) up.destroy();
    });
    if (body !== undefined) up.end(body);
    else req.pipe(up);
  };
  if (!isPerson) return forward();
  // The tests' people's secret, as only the harness has it.
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    let b = {};
    try {
      b = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    } catch {}
    forward(JSON.stringify({ test: TEST_PEOPLE, ...b }));
  });
}
// GET /test-sign-in?as=<username>: that person (made if new, the page's person if first), signed in in this browser.
async function signInBrowser(username: string, res: http.ServerResponse) {
  const r = await fetch(`http://127.0.0.1:${port}/api/auth/test-person`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username }) }).catch(() => null);
  if (!r?.ok) return res.writeHead(r?.status || 502, { "content-type": "text/plain" }).end(`Couldn't sign in as ${username}.`);
  res.writeHead(302, { location: "/", "set-cookie": r.headers.getSetCookie() }).end();
}

/* ---------- start ---------- */

let front: http.Server | null = null;
const sockets = new Set<net.Socket>();
const cliEnv: NodeJS.ProcessEnv = { ...env, AGENTBOOK_PORT: String(cliPort), AGENTBOOK_URL: env.AGENTBOOK_URL || ADDRESS, AGENTBOOK_LINK_POLL_MS: "100", AGENTBOOK_START_UNLINKED: env.AGENTBOOK_START_UNLINKED ?? "1", AGENTBOOK_UPLINK_RETRY_MAX_MS: env.AGENTBOOK_UPLINK_RETRY_MAX_MS ?? "2000" };
if (!machineOnly) for (const k of ["AGENTBOOK_SERVER", "AGENTBOOK_SERVER_TOKEN"]) delete cliEnv[k];
const cliMain = path.join(root, "plugin", "cli", "main.mjs");

if (machineOnly) {
  await free(cliPort);
  run(["--import", STRIP, cliMain, "run"], cliEnv, "agentbook-cli");
} else {
  await Promise.all([free(port), free(serverPort), free(cliPort)]);
  fs.mkdirSync(serverHome, { recursive: true });
  const serverEnv: NodeJS.ProcessEnv = { ...env, AGENTBOOK_SERVER_PORT: String(serverPort), AGENTBOOK_SERVER_HOME: serverHome, AGENTBOOK_SERVER_URL: env.AGENTBOOK_URL || ADDRESS, AGENTBOOK_TEST_PEOPLE: env.AGENTBOOK_TEST_PEOPLE === "0" ? "" : TEST_PEOPLE };
  // As bin/agentbook-server runs it: reading only its code and data, writing only its data, starting nothing.
  // (Node checks paths as they're written, so a folder behind a symlink, like macOS's /var, goes both ways.)
  // agentbook-cli and the plugin as one file in its data, as bin/agentbook-server makes it (server/cli-bundle.ts).
  const bundle = builtBundle();
  if (bundle) {
    fs.copyFileSync(bundle, path.join(serverHome, "cli-bundle.tgz"));
    fs.writeFileSync(path.join(serverHome, "cli-bundle.version"), `${JSON.parse(fs.readFileSync(path.join(root, "plugin", ".claude-plugin", "plugin.json"), "utf8")).version}\n`);
  }
  const both = (p: string) => [...new Set([path.resolve(p), fs.realpathSync(p)])].map((x) => `${x}/`);
  // Its storage (storage.db) is the data folder's when its own is server/ in it, as bin/agentbook-server allows it.
  fs.mkdirSync(home, { recursive: true });
  const storage = fs.existsSync(path.join(home, "server")) && fs.realpathSync(serverHome) === fs.realpathSync(path.join(home, "server")) ? [...new Set([path.resolve(home), fs.realpathSync(home)])].map((x) => `${x}/storage.db*`) : [];
  // Its page, built for it as bin/agentbook-server builds it (build.ts --web), once for every test while web/ is as it is.
  const web = builtWeb();
  serverEnv.AGENTBOOK_WEB_DIR = web;
  // The machine's login (agentbook login, plugin/shared/machine-login.ts), for the account the page is: that one file.
  const login = [path.resolve(home, "machine.json"), path.join(fs.realpathSync(home), "machine.json")];
  const reads = [...[path.join(root, "server"), path.join(root, "plugin", "shared"), serverHome, web].flatMap(both), ...storage, ...new Set(login)].map((p) => `--allow-fs-read=${p}`);
  const writes = [...both(serverHome), ...storage].map((p) => `--allow-fs-write=${p}`);
  // And reaching only this machine, where its integrations' fakes are (harness-egress.ts).
  const guard = fs.realpathSync(path.join(path.dirname(new URL(import.meta.url).pathname), "harness-egress.ts"));
  if (ONE) {
    // As one process, which starts agents, so not under Node's permission model; reaching only this machine still.
    // The server's port is its page's (AGENTBOOK_SERVER_PORT), the CLI's its own.
    run(["--import", STRIP, "--import", guard, cliMain, "run", "--webui"], { ...serverEnv, ...cliEnv }, "agentbook");
  } else {
    // Its entry by its real path too: following a symlink on the way (macOS's /tmp) is a read it isn't allowed. And
    // the stripped files harness-strip.ts keeps, which it reads and adds to.
    fs.mkdirSync(STRIPPED, { recursive: true });
    const stripped = [`--allow-fs-read=${STRIP}`, ...both(STRIPPED).flatMap((p) => [`--allow-fs-read=${p}`, `--allow-fs-write=${p}`]), "--import", STRIP];
    run(["--permission", ...reads, ...writes, `--allow-fs-read=${guard}`, ...stripped, "--import", guard, fs.realpathSync(path.join(root, "server", "main.ts"))], serverEnv, "agentbook-server");
    run(["--import", STRIP, cliMain, "run"], cliEnv, "agentbook-cli");
  }
  // The address answers once both halves do, and the CLI is connected to the server, when it's logged in.
  for (let i = 0; i < 300 && !stopping && !((await up(serverPort)) && (await up(cliPort)) && (await linked())); i++) await sleep(50);
  if (!stopping) {
    front = http.createServer(proxy);
    // A test's event loop stands still while it runs a hook (spawnSync). A socket this closed for being idle then
    // is one it can't see is gone: its next fetch reuses it and fails with ECONNRESET. Nothing here needs them closed.
    front.keepAliveTimeout = 0;
    front.on("connection", (s) => {
      sockets.add(s);
      s.on("close", () => sockets.delete(s));
    });
    front.on("error", (e) => say(e.message));
    // A WebSocket (a terminal's) is the server's too: piped through as it is. DeepSeek Harness's plugin's is the CLI's.
    front.on("upgrade", (req, socket, head) => {
      const up = net.connect(req.url.startsWith("/api/dsh/") ? cliPort : serverPort, "127.0.0.1", () => {
        const lines = [];
        for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
        up.write(`${req.method} ${req.url} HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`);
        if (head?.length) up.write(head);
        socket.pipe(up).pipe(socket);
      });
      up.on("error", () => socket.destroy());
      socket.on("error", () => up.destroy());
      socket.on("close", () => up.destroy());
    });
    front.listen(port, "127.0.0.1");
  }
}
