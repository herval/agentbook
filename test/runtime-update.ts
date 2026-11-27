#!/usr/bin/env node
// Updating Claude Code's, Codex's and Grok's apps on a machine (plugin/cli/runtime-update.ts): only a runtime's name crosses,
// signed; the newest version comes from npm's dist-tags, looked up at most every few hours; an update runs only when
// the machine itself sees it's behind, one at a time, and not while it would cut a Codex turn off. Claude Code's and
// Codex's own update commands run against stand-ins here, never the real ones.
// Run: node test/runtime-update.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRuntimeUpdater, isOlder, runCommand } from "../plugin/cli/runtime-update.ts";
import { createGate } from "../plugin/cli/gate.ts";
import { checkCommand } from "../plugin/shared/protocol.ts";
import { needsSignature } from "../plugin/shared/signed.ts";
import { RUNTIMES, UPDATABLE } from "../plugin/shared/runtimes.ts";
import type { Runtime } from "../plugin/cli/runtimes/runtime.ts";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-runtime-update-"));
process.env.AGENTBOOK_HOME = path.join(base, "home");
delete process.env.AGENTBOOK_NPM_REGISTRY;
const pass = (label: string) => console.log(`PASS  ${label}`);
const until = async (fn: () => boolean) => {
  for (let n = 0; n < 500; n++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("Timed out waiting");
};
const refusedWith = (fn: () => unknown, status: number, re: RegExp) => assert.throws(fn, (e: Error & { status?: number }) => e.status === status && re.test(e.message));

try {
  // ---------- what crosses, and who may send it ----------
  assert.deepEqual(UPDATABLE, ["claude-code", "codex", "grok"]);
  for (const kind of UPDATABLE) assert.equal(checkCommand({ cid: "u", kind: "runtime.update", args: { kind } }), null);
  for (const args of [{ kind: "hermes" }, { kind: "bash" }, { kind: "codex", version: "9.9.9" }, { kind: "claude-code", command: "curl evil | sh" }]) assert(checkCommand({ cid: "u", kind: "runtime.update", args }), JSON.stringify(args));
  assert(needsSignature({ kind: "runtime.update", args: { kind: "codex" } }));
  const gateHome = path.join(base, "gate");
  fs.mkdirSync(path.join(gateHome, "cli"), { recursive: true });
  fs.writeFileSync(path.join(gateHome, "cli", "gate.json"), JSON.stringify({ signed: ["runtime.install"] }));
  assert(createGate({ home: gateHome }).settings().signed.includes("runtime.update"));
  assert(createGate({ home: path.join(base, "no-gate") }).settings().commands["runtime.update"]);
  pass("only Claude Code's, Codex's or Grok's name crosses as runtime.update, signed, never by an operator, and a gate that signs installs signs updates too");

  assert(isOlder("2.1.326", "2.1.332") && !isOlder("2.1.332", "2.1.332") && !isOlder("2.1.332", "2.1.326") && isOlder("0.99.0", "0.172.0") && isOlder("0.171.0-alpha.2", "0.172.0") && !isOlder(null, "1.0.0") && !isOlder("1.0.0", null));
  pass("versions compare by their numbers, and an unknown one is never behind");

  // ---------- the updater, with stand-in runtimes ----------
  type Fake = Runtime & { v: string | null; runs: number; busy: string | null; enabled: boolean; fail: string | null; tagIs: string; release?: () => void };
  const fake = (id: "claude-code" | "codex", pkg: string, v: string): Fake => {
    const f = {
      id, info: RUNTIMES[id], v, runs: 0, busy: null, enabled: true, fail: null, tagIs: "latest",
      health: () => ({ enabled: f.enabled }),
      row: () => ({ ok: true, status: "Ready", detail: "" }),
    } as unknown as Fake;
    f.update = {
      pkg,
      tag: () => f.tagIs,
      version: () => f.v,
      wait: () => f.busy,
      async run(output, signal) {
        f.runs++;
        output("x".repeat(20000));
        await new Promise<void>((r, j) => {
          f.release = r;
          signal.addEventListener("abort", () => j(signal.reason));
        });
        if (f.fail) throw new Error(f.fail);
        f.v = "2.1.332";
      },
    };
    return f;
  };
  const claude = fake("claude-code", "@anthropic-ai/claude-code", "2.1.326");
  const codex = fake("codex", "@openai/codex", "0.172.0");
  const other = fake("claude-code", "@someone/else", "0.0.1"); // a second Claude Code agent (another config folder)
  let clock = Date.parse("2026-11-25T12:00:00Z");
  const asked: string[] = [];
  let registryDown = false;
  const tags = { "@anthropic-ai/claude-code": { stable: "2.1.326", latest: "2.1.332" }, "@openai/codex": { latest: "0.172.0", alpha: "0.174.0-alpha.6" } };
  const request = (async (url: string) => {
    asked.push(url);
    if (registryDown) return new Response("down", { status: 503 });
    const pkg = decodeURIComponent(url.replace(/^.*\/-\/package\/(.*)\/dist-tags$/, "$1"));
    return Response.json(tags[pkg] || {});
  }) as typeof fetch;
  let changes = 0;
  const updater = createRuntimeUpdater({ runtimes: () => [claude, codex, other], request, now: () => clock, changed: () => changes++ });

  assert.deepEqual(updater.info("claude-code"), { version: "2.1.326", latest: null, outdated: false, state: "idle" });
  await updater.check();
  assert.deepEqual(asked, ["https://registry.npmjs.org/-/package/@anthropic-ai/claude-code/dist-tags", "https://registry.npmjs.org/-/package/@openai/codex/dist-tags"]);
  assert.deepEqual(updater.info("claude-code"), { version: "2.1.326", latest: "2.1.332", outdated: true, state: "idle" });
  assert.equal(updater.info("codex").outdated, false);
  assert.equal(updater.info("hermes"), undefined);
  await Promise.all([updater.check(), updater.check()]);
  clock += 5 * 3600e3;
  await updater.check();
  assert.equal(asked.length, 2);
  clock += 2 * 3600e3;
  await updater.check();
  assert.equal(asked.length, 4);
  pass("the newest version is each package's npm dist-tag, looked up once for both runtimes, again only after six hours, and the first Claude Code of several is the one");

  claude.tagIs = "stable";
  await updater.check();
  assert.equal(asked.at(-1), "https://registry.npmjs.org/-/package/@anthropic-ai/claude-code/dist-tags");
  assert.equal(updater.info("claude-code").outdated, false);
  claude.tagIs = "latest";
  registryDown = true;
  clock += 7 * 3600e3;
  await updater.check();
  assert.equal(updater.info("claude-code").latest, "2.1.332");
  const downAt = asked.length;
  clock += 5 * 60e3;
  await updater.check();
  assert.equal(asked.length, downAt);
  clock += 6 * 60e3;
  registryDown = false;
  await updater.check();
  assert(asked.length > downAt);
  claude.v = null;
  const before = asked.length;
  clock += 7 * 3600e3;
  await updater.check();
  assert(!asked.slice(before).some((u) => u.includes("claude-code")));
  claude.v = "2.1.326";
  await updater.check();
  pass("a Claude Code on the stable channel is held to stable's, a failed lookup keeps the last answer and tries again in ten minutes, and a runtime not here isn't looked up");

  refusedWith(() => updater.start("codex"), 409, /0\.172\.0 is the newest/);
  refusedWith(() => updater.start("hermes"), 400, /can't update/);
  claude.enabled = false;
  refusedWith(() => updater.start("claude-code"), 409, /off on this machine/);
  assert.equal(updater.info("claude-code"), undefined);
  claude.enabled = true;
  claude.busy = "A turn is running.";
  assert.equal(updater.info("claude-code").wait, "A turn is running.");
  refusedWith(() => updater.start("claude-code"), 409, /turn is running/);
  claude.busy = null;
  const first = updater.start("claude-code");
  assert.equal(first.state, "updating");
  assert.equal(first.from, "2.1.326");
  assert.equal(updater.start("claude-code").started, first.started);
  assert(updater.busy());
  codex.v = "0.171.0";
  refusedWith(() => updater.start("codex"), 409, /Claude Code is updating/);
  await until(() => !!claude.release);
  assert.equal(updater.info("claude-code").output.length, 16000);
  claude.release();
  await until(() => !updater.busy());
  const done = updater.info("claude-code");
  assert.equal(done.state, "updated");
  assert.equal(done.version, "2.1.332");
  assert.equal(done.outdated, false);
  assert.match(done.output, /Claude Code is 2\.1\.332 now\.\n$/);
  assert.equal(claude.runs, 1);
  assert(changes >= 2);
  pass("an update runs only when the machine sees it's behind and nothing would be cut off, once at a time, in the background, with its output bounded, and reads the version after");

  codex.fail = "codex update exited 1. See what it printed.";
  updater.start("codex");
  await until(() => !!codex.release);
  codex.release();
  await until(() => !updater.busy());
  assert.equal(updater.info("codex").state, "failed");
  assert.match(updater.info("codex").error, /exited 1/);
  assert(updater.info("codex").outdated);
  codex.fail = null;
  codex.release = undefined;
  updater.start("codex");
  assert.equal(updater.info("codex").error, undefined);
  await until(() => !!codex.release);
  updater.close();
  await until(() => !updater.busy());
  assert.match(updater.info("codex").error, /stopped during the update/);
  refusedWith(() => updater.start("codex"), 503, /stopping/);
  let said = "";
  await assert.rejects(runCommand("/bin/sh", ["-c", "echo working; echo 'Error: no permission to write /usr/local/bin' >&2; exit 3"], { output: (t) => (said += t), signal: new AbortController().signal, env: process.env }), /^Error: sh -c .* exited 3: Error: no permission to write \/usr\/local\/bin$/);
  assert.match(said, /^\$ sh -c [\s\S]*working\n/);
  await assert.rejects(runCommand(path.join(base, "nothing-here"), [], { output: () => {}, signal: new AbortController().signal, env: process.env }), /no nothing-here command/);
  pass("a failed update says why and can be retried, which clears it, stopping agentbook stops one that's running, and a command's failure ends with the last line it printed");

  // ---------- an app that says its own newest version (Grok's `grok update --check`) ----------
  let grokNewest: string | Error = "1.0.92";
  let grokAsked = 0;
  const grok = {
    id: "grok", info: RUNTIMES.grok, v: "1.0.89",
    health: () => ({ enabled: true }),
    row: () => ({ ok: true, status: "Ready", detail: "" }),
  } as unknown as Fake;
  grok.update = {
    version: () => grok.v,
    async newest() {
      grokAsked++;
      if (grokNewest instanceof Error) throw grokNewest;
      return grokNewest;
    },
    async run() {
      grok.v = "1.0.92";
    },
  };
  const npmAsked = asked.length;
  let grokClock = Date.parse("2026-11-26T12:00:00Z");
  const grokUpdater = createRuntimeUpdater({ runtimes: () => [grok], request, now: () => grokClock });
  await grokUpdater.check();
  assert.equal(asked.length, npmAsked);
  assert.equal(grokAsked, 1);
  assert.deepEqual(grokUpdater.info("grok"), { version: "1.0.89", latest: "1.0.92", outdated: true, state: "idle" });
  grokUpdater.start("grok");
  await until(() => !grokUpdater.busy());
  assert.equal(grokUpdater.info("grok").state, "updated");
  assert.equal(grokUpdater.info("grok").outdated, false);
  grokClock += 7 * 3600e3;
  grokNewest = "not a version";
  await grokUpdater.check();
  assert.equal(grokUpdater.info("grok").latest, "1.0.92");
  grokClock += 11 * 60e3;
  grokNewest = new Error("grok update --check didn't say its newest version");
  await grokUpdater.check();
  assert.equal(grokUpdater.info("grok").latest, "1.0.92");
  assert.equal(grokAsked, 3);
  pass("an app that isn't on npm says its newest version itself, with no npm lookup; one it can't say keeps the last answer");

  // ---------- Claude Code's own update, against a stand-in `claude` ----------
  const bin = path.join(base, "bin");
  fs.mkdirSync(bin);
  const calls = path.join(base, "calls.log");
  const claudeV = path.join(base, "claude-version");
  fs.writeFileSync(claudeV, "2.1.326");
  fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh
echo "claude $*" >> "${calls}"
case "$1" in
  --version) echo "$(cat "${claudeV}") (Claude Code)";;
  update) test "$CI" = 1 || exit 3; echo "Current version: $(cat "${claudeV}")"; echo "Updating to 2.1.332…"; echo 2.1.332 > "${claudeV}"; echo "Successfully updated";;
  *) exit 2;;
esac
`, { mode: 0o700 });
  process.env.AGENTBOOK_CLAUDE = path.join(bin, "claude");
  process.env.CLAUDE_CONFIG_DIR = path.join(base, "claude-config");
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR);
  const { createClaude, claudeChannel } = await import("../plugin/cli/drivers/claude.ts");
  assert.equal(claudeChannel(), "latest");
  fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, "settings.json"), JSON.stringify({ autoUpdatesChannel: "stable" }));
  assert.equal(claudeChannel(), "stable");
  const driver = createClaude();
  let printed = "";
  await driver.update((t) => (printed += t), new AbortController().signal);
  assert.match(printed, /^\$ claude update\n[\s\S]*Successfully updated/);
  assert.equal(driver.version(), "2.1.332");
  assert.deepEqual(fs.readFileSync(calls, "utf8").trim().split("\n"), ["claude update", "claude --version"]);
  pass("Claude Code updates with `claude update`, its version read at once after, and follows the channel its settings name");

  // ---------- Codex's own update, against a stand-in `codex` ----------
  fs.writeFileSync(calls, "");
  const cliV = path.join(base, "codex-cli-version");
  const daemonV = path.join(base, "codex-daemon-version");
  fs.writeFileSync(cliV, "0.171.0");
  fs.writeFileSync(daemonV, "0.171.0");
  fs.writeFileSync(path.join(bin, "codex"), `#!/bin/sh
echo "codex $*" >> "${calls}"
case "$*" in
  update) test "$CODEX_NON_INTERACTIVE" = 1 || exit 3; echo "Updating Codex via \\\`standalone\\\`…"; echo 0.172.0 > "${cliV}"; echo "Update ran successfully! Please restart Codex.";;
  "app-server daemon version") echo "{\\"status\\":\\"running\\",\\"cliVersion\\":\\"$(cat "${cliV}")\\",\\"appServerVersion\\":\\"$(cat "${daemonV}")\\"}";;
  "app-server daemon update") cp "${cliV}" "${daemonV}"; echo "daemon updated";;
  "app-server daemon start") exit 0;;
  *) exit 2;;
esac
`, { mode: 0o700 });
  process.env.AGENTBOOK_CODEX_BIN = path.join(bin, "codex");
  process.env.AGENTBOOK_CODEX_SOCK = path.join(base, "no-daemon.sock");
  const { createCodex } = await import("../plugin/cli/runtimes/codex/codex.ts");
  const rt = createCodex();
  assert.equal(rt.update.pkg, "@openai/codex");
  assert.equal(rt.update.wait(), null);
  printed = "";
  await rt.update.run((t) => (printed += t), new AbortController().signal);
  assert.equal(rt.update.version(), "0.172.0");
  assert.match(printed, /\$ codex update\n[\s\S]*\$ codex app-server daemon update\n/);
  const ran = fs.readFileSync(calls, "utf8").trim().split("\n").filter((l) => !/daemon start/.test(l));
  assert.deepEqual(ran, ["codex update", "codex app-server daemon version", "codex app-server daemon update", "codex app-server daemon version"]);
  fs.writeFileSync(calls, "");
  await rt.update.run(() => {}, new AbortController().signal);
  assert(!/daemon update/.test(fs.readFileSync(calls, "utf8")));
  pass("Codex updates with `codex update`, then catches its app server up with `codex app-server daemon update` only when it's behind the command, and reads the server's version after");
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
