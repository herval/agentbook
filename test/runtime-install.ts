#!/usr/bin/env node
// Installation receipts, fixed recipes, private launchers and verified downloads. No vendor installer is run.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRuntimeInstaller } from "../plugin/cli/runtime-install.ts";
import { createGate } from "../plugin/cli/gate.ts";
import { checkCommand } from "../plugin/shared/protocol.ts";
import { needsSignature } from "../plugin/shared/signed.ts";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-runtime-install-"));
const oldPath = process.env.PATH;
const oldFetch = globalThis.fetch;
const until = async (fn: () => boolean) => {
  for (let n = 0; n < 200; n++) { if (fn()) return; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error("Timed out waiting for installation");
};
const pass = (label: string) => console.log(`PASS  ${label}`);
const reset = () => { process.env.PATH = "/usr/bin:/bin"; };
const binary = (dir: string, name = "fake") => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o700 });
  return file;
};
try {
  assert.equal(checkCommand({ cid: "install", kind: "runtime.install", args: { kind: "hermes" } }), null);
  assert.equal(checkCommand({ cid: "install", kind: "runtime.install", args: { kind: "grok" } }), null);
  for (const args of [{ kind: "bash" }, { kind: "hermes", script: "echo nope" }, { kind: "dsh", url: "https://elsewhere.example" }]) assert(checkCommand({ cid: "install", kind: "runtime.install", args }));
  assert(needsSignature({ kind: "runtime.install", args: { kind: "hermes" } }));
  const gateHome = path.join(base, "gate");
  fs.mkdirSync(path.join(gateHome, "cli"), { recursive: true });
  fs.writeFileSync(path.join(gateHome, "cli", "gate.json"), JSON.stringify({ signed: ["cloud.setup"] }));
  assert(createGate({ home: gateHome }).settings().signed.includes("runtime.install"));
  pass("only known runtime names cross the protocol, installs need signing, old signing lists migrate, and only a signed command installs");

  reset();
  let release: (v: { bin: string }) => void;
  let calls = 0;
  const announced = [];
  const cliHome = path.join(base, "user's tools $cash");
  const manager = createRuntimeInstaller({ cliHome, platform: "linux", arch: "x64", installed: (kind) => announced.push(kind), perform: async (_kind, dir, output) => {
    calls++;
    output("x".repeat(20000));
    const bin = binary(dir);
    return await new Promise((r) => { release = () => r({ bin }); });
  } });
  assert.equal(manager.info("hermes").state, "available");
  const first = manager.start("hermes");
  assert(manager.busy());
  assert.equal(manager.start("hermes").started, first.started);
  assert.equal(calls, 1);
  assert.throws(() => manager.start("dsh"), /Another agent/);
  assert.equal(manager.info("hermes").output.length, 16000);
  release({ bin: "unused" });
  await until(() => !manager.busy());
  assert.equal(manager.info("hermes").state, "installed");
  assert.deepEqual(announced, ["hermes"]);
  const launcher = path.join(cliHome, "runtimes", "bin", "hermes");
  const ran = spawnSync(launcher, ["literal $HOME", "has a ' quote"], { encoding: "utf8" });
  assert.equal(ran.status, 0);
  assert.equal(ran.stdout, "literal $HOME\nhas a ' quote\n");
  assert.equal(fs.statSync(path.join(cliHome, "runtimes", "installs.json")).mode & 0o777, 0o600);
  assert.equal(manager.start("hermes").state, "installed");
  assert.equal(calls, 1);
  pass("install starts in the background once, serializes installs, bounds output, keeps private receipts and creates a safely quoted executable launcher");

  reset();
  let fail = true;
  const retryHome = path.join(base, "retry");
  const retry = createRuntimeInstaller({ cliHome: retryHome, platform: "linux", perform: async (_kind, dir, output) => {
    output("installer output\n");
    if (fail) throw new Error("The download failed");
    return { bin: binary(dir) };
  } });
  retry.start("hermes"); await until(() => !retry.busy());
  assert.equal(retry.info("hermes").state, "failed");
  assert.match(retry.info("hermes").error, /download failed/);
  fail = false;
  retry.start("hermes"); await until(() => !retry.busy());
  assert.equal(retry.info("hermes").state, "installed");
  assert.equal(retry.info("hermes").error, undefined);
  const recovered = createRuntimeInstaller({ cliHome: retryHome, platform: "linux" });
  assert.equal(recovered.info("hermes").state, "installed");
  pass("errors and output survive as receipts, retry clears the error, and an installed runtime survives restarting the manager");

  reset();
  const stopped = createRuntimeInstaller({ cliHome: path.join(base, "stopped"), platform: "linux", perform: async (_kind, _dir, _output, signal) => new Promise((_r, reject) => signal.addEventListener("abort", () => reject(signal.reason))) });
  stopped.start("hermes"); stopped.close(); await until(() => !stopped.busy());
  assert.match(stopped.info("hermes").error, /stopped/);
  const interrupted = path.join(base, "interrupted");
  fs.mkdirSync(path.join(interrupted, "runtimes"), { recursive: true });
  fs.writeFileSync(path.join(interrupted, "runtimes", "installs.json"), JSON.stringify({ hermes: { state: "installing" } }));
  assert.equal(createRuntimeInstaller({ cliHome: interrupted }).info("hermes").state, "failed");
  fs.writeFileSync(path.join(interrupted, "runtimes", "installs.json"), "null");
  assert.equal(createRuntimeInstaller({ cliHome: interrupted }).info("hermes").state, "available");
  const unsupported = createRuntimeInstaller({ cliHome: path.join(base, "unsupported"), platform: "win32" });
  assert.equal(unsupported.info("hermes"), undefined);
  assert.throws(() => unsupported.start("hermes"), /Linux and macOS/);
  assert.throws(() => manager.start("hermes; echo bad"), /no in-app installer/);
  pass("interrupted and corrupt receipts are recoverable, closing cancels the job, and unsupported systems and arbitrary command names cannot start an install");

  reset();
  const fixture = path.join(base, "archive");
  fs.mkdirSync(fixture);
  binary(fixture, "antigravity");
  const archive = path.join(base, "fixture.tar.gz");
  assert.equal(spawnSync("tar", ["-czf", archive, "-C", fixture, "antigravity"]).status, 0);
  const bytes = fs.readFileSync(archive);
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  let badHash = true;
  let badHost = false;
  let fetched: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input); fetched.push(url);
    if (url === "https://formulae.brew.sh/api/cask/antigravity-cli.json") return Response.json({ variations: { x86_64_linux: { url: badHost ? "https://elsewhere.example/agent.tgz" : "https://storage.googleapis.com/antigravity-public/antigravity-cli/test/cli_linux_x64.tar.gz", sha256: badHash ? "0".repeat(64) : digest } } });
    assert(url.startsWith("https://storage.googleapis.com/antigravity-public/antigravity-cli/"));
    return new Response(bytes);
  };
  const downloads = createRuntimeInstaller({ cliHome: path.join(base, "verified"), platform: "linux", arch: "x64" });
  downloads.start("antigravity"); await until(() => !downloads.busy());
  assert.match(downloads.info("antigravity").error, /checksum/);
  assert(!fs.existsSync(path.join(base, "verified", "runtimes", "antigravity", "antigravity")));
  badHash = false; badHost = true; fetched = [];
  downloads.start("antigravity"); await until(() => !downloads.busy());
  assert.match(downloads.info("antigravity").error, /no verified download/);
  assert.equal(fetched.length, 1);
  badHost = false;
  downloads.start("antigravity"); await until(() => !downloads.busy());
  assert.equal(downloads.info("antigravity").state, "installed");
  assert.equal(spawnSync(path.join(base, "verified", "runtimes", "bin", "agy"), ["verified"], { encoding: "utf8" }).stdout, "verified\n");
  pass("the real Linux Antigravity recipe rejects a bad checksum or download host before extraction, and publishes only the verified executable");

  reset();
  const nodeFixture = path.join(base, "node-fixture", "node-v24.99.0-linux-x64");
  fs.mkdirSync(path.join(nodeFixture, "bin"), { recursive: true });
  fs.mkdirSync(path.join(nodeFixture, "lib", "node_modules", "npm", "bin"), { recursive: true });
  fs.writeFileSync(path.join(nodeFixture, "lib", "node_modules", "npm", "bin", "npm-cli.js"), "fixture");
  fs.writeFileSync(path.join(nodeFixture, "bin", "node"), `#!/bin/sh
test "$2" = install && test "$3" = --prefix && test "$7" = @deepseek-ai/dsh || exit 1
mkdir -p "$4/node_modules/.bin"
cat > "$4/node_modules/.bin/dsh" <<'SCRIPT'
#!/bin/sh
command -v node
printf '%s\\n' "$@"
SCRIPT
chmod 700 "$4/node_modules/.bin/dsh"
`, { mode: 0o700 });
  const nodeArchive = path.join(base, "node-fixture.tar.gz");
  assert.equal(spawnSync("tar", ["-czf", nodeArchive, "-C", path.dirname(nodeFixture), path.basename(nodeFixture)]).status, 0);
  const nodeBytes = fs.readFileSync(nodeArchive);
  const nodeHash = crypto.createHash("sha256").update(nodeBytes).digest("hex");
  globalThis.fetch = async (input) => String(input).endsWith("SHASUMS256.txt") ? new Response(`${nodeHash}  node-v24.99.0-linux-x64.tar.gz\n`) : new Response(nodeBytes);
  const dshHome = path.join(base, "dsh's tools");
  const dsh = createRuntimeInstaller({ cliHome: dshHome, platform: "linux", arch: "x64" });
  dsh.start("dsh"); await until(() => !dsh.busy());
  assert.equal(dsh.info("dsh").state, "installed", dsh.info("dsh").error);
  const privateNode = path.join(dshHome, "runtimes", "dsh", "node", "bin", "node");
  const dshRun = spawnSync(path.join(dshHome, "runtimes", "bin", "dsh"), ["a project", "$HOME"], { encoding: "utf8" });
  assert.equal(dshRun.status, 0);
  assert.equal(dshRun.stdout, `${privateNode}\na project\n$HOME\n`);
  assert(!process.env.PATH.includes(path.dirname(privateNode)));
  pass("the real DSH recipe verifies and extracts Node, installs the named npm package, and uses that Node only inside its launcher");

  reset();
  const userHome = path.join(base, "hermes-user");
  const entry = path.join(userHome, ".local", "bin");
  globalThis.fetch = async () => new Response(`#!/bin/bash
test "$1" = --non-interactive && test "$2" = --verbose || exit 1
mkdir -p '${entry}'
printf '#!/bin/sh\\nprintf "hermes fixture\\\\n"\\n' > '${entry}/hermes'
chmod 700 '${entry}/hermes'
echo 'Hermes fixture installed'
`);
  const hermes = createRuntimeInstaller({ cliHome: path.join(base, "hermes"), userHome, platform: "linux" });
  hermes.start("hermes"); await until(() => !hermes.busy());
  assert.equal(hermes.info("hermes").state, "installed", hermes.info("hermes").error);
  assert.match(hermes.info("hermes").output, /Hermes fixture installed/);
  pass("the Hermes recipe runs the official script without interactive prompts and publishes its documented user launcher");

  reset();
  const grokUser = path.join(base, "grok-user");
  let grokFrom = "";
  globalThis.fetch = async (input) => {
    grokFrom = String(input);
    return new Response(`#!/bin/bash
test -z "$1" && test "$GROK_BIN_DIR" = '${grokUser}/.grok/bin' || exit 1
mkdir -p "$GROK_BIN_DIR"
printf '#!/bin/sh\\nprintf "grok fixture\\\\n"\\n' > "$GROK_BIN_DIR/grok"
chmod 700 "$GROK_BIN_DIR/grok"
echo "Grok fixture installed to $GROK_BIN_DIR/grok"
`);
  };
  const grok = createRuntimeInstaller({ cliHome: path.join(base, "grok"), userHome: grokUser, platform: "darwin", arch: "arm64" });
  grok.start("grok"); await until(() => !grok.busy());
  assert.equal(grok.info("grok").state, "installed", grok.info("grok").error);
  assert.equal(grokFrom, "https://x.ai/cli/install.sh");
  assert.equal(spawnSync(path.join(base, "grok", "runtimes", "bin", "grok"), [], { encoding: "utf8" }).stdout, "grok fixture\n");
  pass("the Grok recipe runs x.ai's official script into ~/.grok/bin, where `grok update` updates it, and launches it from there");
} finally {
  process.env.PATH = oldPath;
  globalThis.fetch = oldFetch;
  fs.rmSync(base, { recursive: true, force: true });
}
