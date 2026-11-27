#!/usr/bin/env node
// Shared machines, step 1. Each person on a shared Linux machine has
// their own Linux user, with no sudo and no docker group, and their own agentbook-cli on a port of their own.
// `agentbook-cli seat` sets it up, as root. Their sessions' hooks and tools find their port in /etc/agentbook/seats.json
// by their uid. They never start a second agentbook-cli where systemd runs theirs. They don't take another person's
// agentbook-cli for their own.
//
// Everywhere: names, ports, the unit and the PATH, what counts as code only root can change, and finding a seat's port.
// Linux as root only (on the boat sandbox, or CI with sudo): two real seats, each person's agentbook-cli running as
// them, what each of them can reach, and removing both.
// Run: node test/seats.ts     (sudo node test/seats.ts for the Linux part)

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MARK, PRIVILEGED, addSeat, checkName, envText, installEnv, parsePasswd, pathFor, pickPort, rustupIn, readSeats, removeSeat, unitText, unsafeCode } from "../plugin/cli/seats.ts";
import { seatOf, seatsIn } from "../plugin/lib/common.ts";

const TEST = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(TEST, "..", "plugin");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-seats-"));
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? `: ${detail}` : ""}`);
  if (!ok) failed++;
};
const throws = (fn, re) => {
  try {
    fn();
    return false;
  } catch (e) {
    return re.test(e.message);
  }
};
// A child node, as given, printing what `code` logs.
function node(code: string, { env = {}, uid, gid, cwd, bin = process.execPath }: { env?: Record<string, string>; uid?: number; gid?: number; cwd?: string; bin?: string } = {}) {
  const r = spawnSync(bin, ["--input-type=module", "-e", code], { env: { PATH: process.env.PATH, ...env }, uid, gid, cwd, encoding: "utf8", timeout: 30000 });
  return { out: (r.stdout || "").trim(), err: (r.stderr || "").trim(), status: r.status };
}
const COMMON = JSON.stringify(path.join(PLUGIN, "lib", "common.ts"));

/* ---------- everywhere ---------- */

check("a username is a seat's name", checkName("herval") === "herval" && checkName("banana-2") === "banana-2" && checkName("a_b") === "a_b");
check("names Linux can't take are refused", ["Herval", "1abc", "a b", "-x", "", "a".repeat(33), "x/y"].every((n) => throws(() => checkName(n), /can't be a Linux user's name/)));
check("the machine's own names are refused", ["root", "ubuntu", "user", "nobody"].every((n) => throws(() => checkName(n), /a name this machine has for itself/)));
check("a passwd line reads", JSON.stringify(parsePasswd("banana:x:1002:1003:agentbook seat:/home/banana:/bin/bash")) === JSON.stringify({ name: "banana", uid: 1002, gid: 1003, gecos: MARK, home: "/home/banana", shell: "/bin/bash" }));
check("a short passwd line is nobody", parsePasswd("banana:x:1002") === null);

check("the first seat gets 4321", pickPort({}) === 4321);
check("a port another seat has is skipped", pickPort({ a: { port: 4321 }, b: { port: 4322 } }) === 4323);
check("a port something listens on is skipped", pickPort({ a: { port: 4321 } }, (p) => p === 4322) === 4323);
check("every port taken says so", throws(() => pickPort({}, () => true), /Every port from 4321 to 4399 is taken/));

const unit = unitText({ node: "/usr/local/bin/node", plugin: "/opt/agentbook/plugin", file: "/etc/agentbook/seats.json" });
check("the unit runs as the seat's user", /^User=%i$/m.test(unit) && /^Group=%i$/m.test(unit));
check("nothing under it gains privileges", /^NoNewPrivileges=yes$/m.test(unit));
check("what it starts outlives a restart of it", /^KillMode=process$/m.test(unit));
check("systemd keeps it running, and login knows", /^Restart=always$/m.test(unit) && /^Environment=AGENTBOOK_SUPERVISED=1$/m.test(unit));
check("it runs that Node and that plugin", /^ExecStart=\/usr\/local\/bin\/node \/opt\/agentbook\/plugin\/cli\/main\.mjs run$/m.test(unit));
check("each seat has its settings file", /^EnvironmentFile=\/etc\/agentbook\/seats\/%i\.env$/m.test(unit));
check("and the machine's, if it has one, goes first", /^EnvironmentFile=-\/etc\/agentbook\/seats\.env\nEnvironmentFile=\/etc\/agentbook\/seats\/%i\.env$/m.test(unit));
const env = envText({ machine: "boat-littleguys", plugin: "/opt/agentbook/plugin", node: "/usr/local/bin/node", home: "/home/banana" });
check("a seat's settings: the machine's name and the plugin", /^AGENTBOOK_MACHINE=boat-littleguys$/m.test(env) && /^AGENTBOOK_PLUGIN_DIR=\/opt\/agentbook\/plugin$/m.test(env));
check("a machine agentbook made has its own settings for everyone, under the machine's and the seat's", unit.indexOf("EnvironmentFile=-/etc/environment\n") > 0 && unit.indexOf("EnvironmentFile=-/etc/environment\n") < unit.indexOf("EnvironmentFile=-/etc/agentbook/cli.env\n") && unit.indexOf("/etc/agentbook/cli.env\n") < unit.indexOf("/etc/agentbook/image.env\n") && unit.indexOf("/etc/agentbook/image.env\n") < unit.indexOf("/etc/agentbook/seats.env\n"));
check("the machine's tools go on a seat's PATH after their own folder and before the Node", pathFor({ home: "/home/banana", node: "/usr/lib/agentbook/node", tools: ["/home/user/.nvm/versions/node/v22.1.0/bin", "/usr/bin"] }).startsWith("/home/banana/.local/bin:/home/banana/.cargo/bin:/home/user/.nvm/versions/node/v22.1.0/bin:/usr/bin:/usr/lib/agentbook:/usr/local/sbin:"));
check("what a seat's agents install goes into its own home: npm -g, go install, cargo install", installEnv({ home: "/home/banana", rustup: "/home/user/.rustup" }).join("\n") === "NPM_CONFIG_PREFIX=/home/banana/.local\nGOBIN=/home/banana/.local/bin\nCARGO_HOME=/home/banana/.cargo\nRUSTUP_HOME=/home/user/.rustup" && /^NPM_CONFIG_PREFIX=\/home\/banana\/\.local$/m.test(env) && !/RUSTUP_HOME/.test(env));
check("the machine's Rust compiler is read from where its cargo is", rustupIn(["/usr/bin", "/home/user/.cargo/bin"], { exists: (p) => p === "/home/user/.rustup" }) === "/home/user/.rustup" && rustupIn(["/home/user/.cargo/bin"], { exists: () => false }) === null);
check("a seat's PATH has their own Claude Code first, then the Node", /^PATH=\/home\/banana\/\.local\/bin:\/home\/banana\/\.cargo\/bin:\/usr\/local\/bin:/m.test(env) && env.match(/\/usr\/local\/bin/g).length === 1);

// What counts as code only root can change: every folder up to /, root's and not writable by others, except a
// sticky folder above it (/tmp), where nobody else can move it.
const tree = (modes: Record<string, [number, number]>) => ({ realpath: (p: string) => p, lstat: (p: string) => ({ uid: modes[p]?.[0] ?? 0, mode: modes[p]?.[1] ?? 0o40755, isDirectory: () => !!((modes[p]?.[1] ?? 0o40755) & 0o40000) }) });
check("root's all the way up is safe", unsafeCode("/opt/agentbook/plugin", tree({})) === null);
check("someone else's folder on the way is not", /isn't root's/.test(unsafeCode("/home/user/agentbook/plugin", tree({ "/home/user": [1000, 0o40750] }))));
check("a folder others can write is not", /can be changed by others/.test(unsafeCode("/opt/agentbook/plugin", tree({ "/opt/agentbook": [0, 0o40775] }))));
check("a sticky folder above it is fine", unsafeCode("/tmp/x/plugin", tree({ "/tmp": [0, 0o41777] })) === null);
check("the thing itself can't be writable by others", /can be changed by others/.test(unsafeCode("/usr/local/bin/node", tree({ "/usr/local/bin/node": [0, 0o100777] }))));
check("a path with a space is refused", /space/.test(unsafeCode("/opt/a b", tree({}))));
check("a path that isn't there is refused", /isn't there/.test(unsafeCode(path.join(TMP, "nothing"))));

// Finding a seat. The file only counts if root alone can change it, and its folder.
const seatsFile = path.join(TMP, "seats.json");
fs.writeFileSync(seatsFile, JSON.stringify({ machine: "boat-littleguys", seats: { banana: { uid: 4242, port: 4333 }, herval: { uid: process.getuid(), port: 4377 } } }));
check("a seats file root can't vouch for doesn't count", seatsIn(seatsFile, { stat: () => ({ uid: 1000, mode: 0o100644 }) }) === null && !process.env.AGENTBOOK_SEATS_FILE);
check("nor one others can write", seatsIn(seatsFile, { stat: () => ({ uid: 0, mode: 0o100666 }) }) === null);
check("root's, written by root alone, counts", seatsIn(seatsFile, { stat: () => ({ uid: 0, mode: 0o100644 }) })?.machine === "boat-littleguys");
const all = { machine: "m", seats: { banana: { uid: 4242, port: 4333 } } };
check("a uid finds its seat", JSON.stringify(seatOf(4242, all)) === JSON.stringify({ name: "banana", uid: 4242, port: 4333 }));
check("another uid has none", seatOf(4243, all) === null && seatOf(4242, null) === null);
check("a seat without a port is none", seatOf(7, { machine: "m", seats: { x: { uid: 7, port: "4321" } } }) === null);

// A session's hooks and tools, on a seat: their person's port, unless they're told one.
const asSeat = { AGENTBOOK_SEATS_FILE: seatsFile, HOME: TMP };
check("a seat's sessions use its port", node(`import(${COMMON}).then((m) => console.log(m.PORT, m.SEAT?.name))`, { env: asSeat }).out === "4377 herval");
check("AGENTBOOK_PORT still wins", node(`import(${COMMON}).then((m) => console.log(m.PORT))`, { env: { ...asSeat, AGENTBOOK_PORT: "4999" } }).out === "4999");
check("off a shared machine it's 4320", node(`import(${COMMON}).then((m) => console.log(m.PORT, m.SEAT))`, { env: { AGENTBOOK_SEATS_FILE: path.join(TMP, "none.json"), HOME: TMP } }).out === "4320 null");
// A seat's agentbook-cli is a service: a hook never starts one, and says where to look when it's down.
const free = 4377;
const began = Date.now();
const started = node(`import(${COMMON}).then(async (m) => console.log(JSON.stringify(await m.startCli())))`, { env: asSeat });
// What the hook said: whether agentbook-cli is up, and why not.
let said: { up?: boolean; why?: string } = {};
try {
  said = JSON.parse(started.out);
} catch {}
check("a hook on a seat doesn't start agentbook-cli", said.up === false && /herval's agentbook-cli isn't running.*systemctl status agentbook-cli@herval/.test(said.why || ""), started.out || started.err);
check("it waits a few seconds for systemd, inside SessionStart's 10", Date.now() - began >= 4000 && Date.now() - began < 9500, `${Date.now() - began} ms`);
const nothing = await fetch(`http://127.0.0.1:${free}/api/health`, { signal: AbortSignal.timeout(1000) }).then(() => "something", () => "nothing");
check("and nothing listens on its port after", nothing === "nothing");

// A thread whose folder agentbook-cli can't open says so, rather than "spawn claude EACCES", and one whose folder is
// gone says that.
const { folderTrouble } = await import("../plugin/cli/drivers/claude.ts");
const locked = path.join(TMP, "locked");
fs.mkdirSync(path.join(locked, "littleguys"), { recursive: true });
fs.chmodSync(locked, 0o700);
check("a folder it can open is no trouble", folderTrouble(path.join(locked, "littleguys")) === null);
check("a folder that's gone says so", /Its folder is gone/.test(folderTrouble(path.join(TMP, "gone", "littleguys"))?.message));
if (process.getuid() !== 0) {
  fs.chmodSync(locked, 0o000);
  check("a folder it can't open says whose it can't be", /runs as .+, who can't open its folder/.test(folderTrouble(path.join(locked, "littleguys"))?.message || ""));
  fs.chmodSync(locked, 0o700);
}
if (process.getuid() !== 0) {
  // A thread woken in it, as a message to it does: what herval saw on boat-littleguys.
  fs.chmodSync(locked, 0o000);
  const woke = spawnSync(process.execPath, ["--input-type=module", "-e", `import(${JSON.stringify(path.join(PLUGIN, "cli", "drivers", "claude.ts"))}).then((m) => m.createClaude().resume({ sessionId: "s1", cwd: ${JSON.stringify(path.join(locked, "littleguys"))}, prompt: "Show it in dark mode" })).catch((e) => console.log(e.message))`], { encoding: "utf8", env: { ...process.env, AGENTBOOK_CLAUDE: "/bin/echo" } });
  fs.chmodSync(locked, 0o700);
  check("waking a thread there says so, not spawn claude EACCES", /who can't open its folder/.test(woke.stdout) && !/EACCES/.test(woke.stdout), woke.stdout + woke.stderr);
}

/* ---------- Linux, as root: real seats ---------- */

if (process.platform !== "linux" || process.getuid() !== 0) {
  console.log("skip the real seats: they need Linux and root (sudo node test/seats.ts)");
} else {
  await realSeats();
}

async function realSeats() {
  // agentbook's code and the Node it runs on, where only root can change them, as on a real shared machine.
  const box = fs.mkdtempSync("/tmp/agentbook-seat-code-");
  fs.chmodSync(box, 0o755);
  spawnSync("cp", ["-a", PLUGIN, path.join(box, "plugin")]);
  spawnSync("cp", [process.execPath, path.join(box, "node")]);
  spawnSync("chown", ["-R", "root:root", box]);
  spawnSync("chmod", ["-R", "go-w", box]);
  const etc = path.join(box, "etc");
  fs.mkdirSync(etc, { mode: 0o755 });
  const file = path.join(etc, "seats.json");
  process.env.AGENTBOOK_SYSTEMD_DIR = path.join(box, "systemd");
  fs.mkdirSync(process.env.AGENTBOOK_SYSTEMD_DIR);
  const opts = { file, plugin: path.join(box, "plugin"), node: path.join(box, "node"), machine: "seat-test", start: false };
  const A = `abt${process.pid % 10000}a`;
  const B = `abt${process.pid % 10000}b`;
  const children = [];
  try {
    const sayA = addSeat(A, opts);
    check("a seat is made", new RegExp(`Made ${A}'s seat on seat-test`).test(sayA), sayA);
    const pwA = parsePasswd(spawnSync("getent", ["passwd", A], { encoding: "utf8" }).stdout);
    check("its Linux user carries agentbook's mark", pwA?.gecos === MARK);
    check("its home is theirs alone", (fs.statSync(pwA.home).mode & 0o777) === 0o700 && fs.statSync(pwA.home).uid === pwA.uid);
    // One that got into sudo is taken out when its seat is made sure of again.
    const sudo = spawnSync("getent", ["group", "sudo"]).status === 0;
    if (sudo) spawnSync("usermod", ["-aG", "sudo", A]);
    const again = addSeat(A, opts);
    const groups = spawnSync("id", ["-nG", A], { encoding: "utf8" }).stdout.trim().split(/\s+/);
    check("it's in no group that amounts to root", !groups.some((g) => PRIVILEGED.includes(g)), groups.join(" "));
    if (sudo) check("one put in sudo is taken out again", /Took .* out of sudo/.test(again), again);
    check("making sure again keeps its port", /Kept/.test(again) && readSeats(file).seats[A].port === 4321);
    addSeat(B, opts);
    const pwB = parsePasswd(spawnSync("getent", ["passwd", B], { encoding: "utf8" }).stdout);
    const seats = readSeats(file);
    check("each seat has a port of its own", seats.seats[A].port !== seats.seats[B].port && seats.machine === "seat-test");
    check("the unit and settings are written", fs.existsSync(path.join(process.env.AGENTBOOK_SYSTEMD_DIR, "agentbook-cli@.service")) && fs.readFileSync(path.join(etc, "seats", `${A}.env`), "utf8").includes("AGENTBOOK_MACHINE=seat-test"));
    check("a Linux user agentbook didn't make is left alone", throws(() => addSeat("daemon", opts), /a name this machine has|didn't make/));
    spawnSync("useradd", ["--no-create-home", `${A}x`]);
    check("so is one with a free name", throws(() => addSeat(`${A}x`, opts), /agentbook didn't make/));
    spawnSync("userdel", [`${A}x`]);
    check("root's agentbook-cli refuses to run on a shared machine", /never as root/.test(node(`import(${JSON.stringify(path.join(box, "plugin", "cli", "main.mjs"))}).then((m) => m.runCli()).catch((e) => console.log(e.message))`, { env: { AGENTBOOK_SEATS_FILE: file, HOME: "/root" } }).out));

    // Each person's agentbook-cli, as them, as systemd would run it.
    const envOf = (pw) => ({ HOME: pw.home, USER: pw.name, PATH: `${box}:/usr/bin:/bin`, AGENTBOOK_SEATS_FILE: file, AGENTBOOK_MACHINE: "seat-test", AGENTBOOK_SUPERVISED: "1", AGENTBOOK_CLAUDE_CODE: "0", AGENTBOOK_CODEX: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_DSH: "0", AGENTBOOK_TERMINAL: "0" });
    for (const pw of [pwA, pwB]) {
      const log = fs.openSync(path.join(box, `${pw.name}.log`), "w");
      children.push(spawn(path.join(box, "node"), [path.join(box, "plugin", "cli", "main.mjs"), "run"], { uid: pw.uid, gid: pw.gid, cwd: pw.home, env: envOf(pw), stdio: ["ignore", log, log] }));
    }
    const up = async (port) => {
      for (let i = 0; i < 50; i++) {
        if (await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) }).then(() => true, () => false)) return true;
        await new Promise((r) => setTimeout(r, 200));
      }
      return false;
    };
    check("both seats' agentbook-clis are running", (await up(seats.seats[A].port)) && (await up(seats.seats[B].port)), fs.readFileSync(path.join(box, `${A}.log`), "utf8").slice(-400));
    const owner = (port) => spawnSync("sh", ["-c", `ss -Hltnp 'sport = :${port}' | grep -o 'pid=[0-9]*' | head -1`], { encoding: "utf8" }).stdout.trim().slice(4);
    const uidOf = (pid) => Number(/^Uid:\s+(\d+)/m.exec(fs.readFileSync(`/proc/${pid}/status`, "utf8"))[1]);
    check("each one runs as its person", uidOf(owner(seats.seats[A].port)) === pwA.uid && uidOf(owner(seats.seats[B].port)) === pwB.uid);
    check("its key is in its home", fs.existsSync(path.join(pwA.home, ".agentbook", "cli", "local.key")));

    // As each person: their own agentbook-cli, the other's, and the other's key.
    const PROBE = `import(${JSON.stringify(path.join(box, "plugin", "lib", "common.ts"))}).then(async (m) => {
      const fs = await import("node:fs");
      const mine = await m.apiCall("GET", "/api/health").then((r) => r.how, (e) => "error: " + e.message);
      const theirs = await m.localFetch("http://127.0.0.1:" + process.env.OTHER_PORT + "/api/health").then((r) => r.how, (e) => "refused: " + e.code);
      let read = "read";
      try { fs.readFileSync(process.env.OTHER_KEY); } catch (e) { read = e.code; }
      console.log(JSON.stringify({ port: m.PORT, seat: m.SEAT?.name, mine, theirs, read }));
    })`;
    const call = (pw, other) => node(PROBE, { env: { ...envOf(pw), OTHER_PORT: String(seats.seats[other.name].port), OTHER_KEY: path.join(other.home, ".agentbook", "cli", "local.key") }, uid: pw.uid, gid: pw.gid, cwd: pw.home, bin: path.join(box, "node") });
    const a = JSON.parse(call(pwA, pwB).out || "{}");
    const b = JSON.parse(call(pwB, pwA).out || "{}");
    check("A's tools find A's port, by A's uid", a.port === seats.seats[A].port && a.seat === A);
    check("A's agentbook-cli proves itself to A's tools", a.mine === "proof", a.mine);
    check("B's tools find B's", b.port === seats.seats[B].port && b.mine === "proof", JSON.stringify(b));
    check("B's tools don't take A's agentbook-cli for theirs", b.theirs === "refused: not-agentbook", b.theirs);
    check("B can't read A's key", b.read === "EACCES", b.read);
    const sudoTry = spawnSync("sudo", ["-n", "true"], { uid: pwA.uid, gid: pwA.gid, env: { PATH: "/usr/bin:/bin", HOME: pwA.home }, encoding: "utf8" });
    check("A has no sudo", sudoTry.status !== 0);
  } finally {
    for (const c of children) c.kill("SIGKILL");
    for (const n of [A, B]) {
      try {
        const said = removeSeat(n, { file });
        check(`${n}'s seat is removed`, /Removed/.test(said));
      } catch (e) {
        check(`${n}'s seat is removed`, false, e.message);
      }
    }
    check("their Linux users are gone", spawnSync("getent", ["passwd", A]).status !== 0 && spawnSync("getent", ["passwd", B]).status !== 0);
    check("and so are their homes", !fs.existsSync(`/home/${A}`) && !fs.existsSync(`/home/${B}`));
    check("the seats file has nobody", Object.keys(readSeats(file).seats).length === 0);
    fs.rmSync(box, { recursive: true, force: true });
  }
}

fs.rmSync(TMP, { recursive: true, force: true });
if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log("seats: all passed");
