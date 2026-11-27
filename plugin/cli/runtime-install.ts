// The machine owns the install recipes. The page can name a runtime, never a command or a download URL.
// Installs and their logs belong to this OS account; a daemon restart leaves a failed receipt that can be retried.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanEnv } from "../lib/common.ts";
import type { RuntimeInstall } from "../shared/runtimes.ts";
import { onPath } from "./runtimes/kit/spawn.ts";

const RECIPES = {
  hermes: { bin: "hermes", source: "https://hermes-agent.nousresearch.com/docs/getting-started/installation", after: "Run hermes setup to choose your model provider before starting a thread." },
  dsh: { bin: "dsh", source: "https://github.com/deepseek-ai/deepseek-harness", after: "Configure your model and API key in DeepSeek Harness before starting a thread." },
  antigravity: { bin: "agy", source: "https://antigravity.google/product/antigravity-cli", after: "Run agy once to sign in to Google before starting a thread." },
  grok: { bin: "grok", source: "https://docs.x.ai/build/overview", after: "Sign in to Grok from its provider setup here, or run grok login, before starting a thread." },
} as const;
type Kind = keyof typeof RECIPES;
type Job = Pick<RuntimeInstall, "state" | "started" | "finished" | "output" | "error">;
type Output = (text: string) => void;
type Perform = (kind: Kind, dir: string, output: Output, signal: AbortSignal) => Promise<{ bin: string; node?: string }>;
const isKind = (kind: unknown): kind is Kind => typeof kind === "string" && Object.hasOwn(RECIPES, kind);
const quote = (text: string) => `'${text.replace(/'/g, `'"'"'`)}'`;
const refusal = (status: number, message: string) => Object.assign(new Error(message), { status });

export function createRuntimeInstaller({ cliHome, userHome = os.homedir(), platform = process.platform, arch = process.arch, changed = () => {}, installed = (_kind: Kind) => {}, perform, log = (_text: string) => {} }: {
  cliHome: string; userHome?: string; platform?: NodeJS.Platform; arch?: string;
  changed?: () => void; installed?: (kind: Kind) => void; perform?: Perform; log?: Output;
}) {
  const root = path.join(cliHome, "runtimes");
  const bins = path.join(root, "bin");
  const receipt = path.join(root, "installs.json");
  const supported = ["darwin", "linux"].includes(platform) && ["x64", "arm64"].includes(arch);
  // Only the runtime launchers go on PATH. DSH's private Node never replaces Node for other agents.
  if (!(process.env.PATH || "").split(path.delimiter).includes(bins)) process.env.PATH = [bins, process.env.PATH].filter(Boolean).join(path.delimiter);
  let jobs: Partial<Record<Kind, Job>> = {};
  try {
    const saved = JSON.parse(fs.readFileSync(receipt, "utf8"));
    for (const [kind, job] of Object.entries(saved || {})) if (isKind(kind) && job && typeof job === "object" && ["installing", "installed", "failed"].includes((job as Job).state)) jobs[kind] = job as Job;
  } catch {}
  const save = () => {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.writeFileSync(`${receipt}.tmp`, JSON.stringify(jobs), { mode: 0o600 });
    fs.renameSync(`${receipt}.tmp`, receipt);
  };
  for (const job of Object.values(jobs)) if (job.state === "installing") {
    job.state = "failed";
    job.error = "Agentbook stopped during installation. Retry to finish it.";
    job.finished = new Date().toISOString();
    save();
  }
  let active: { kind: Kind; controller: AbortController } | null = null;
  let closed = false;
  function info(kind: string): RuntimeInstall | undefined {
    if (!supported || !isKind(kind)) return;
    const job = jobs[kind];
    const present = !!onPath(RECIPES[kind].bin);
    const state = job?.state === "installing" || job?.state === "failed" ? job.state : present ? "installed" : "available";
    return { ...job, source: RECIPES[kind].source, after: RECIPES[kind].after, state };
  }
  function start(kind: unknown) {
    if (!isKind(kind)) throw refusal(400, "That runtime has no in-app installer.");
    if (!supported) throw refusal(409, "In-app installs support Linux and macOS on Intel and ARM64.");
    if (closed) throw refusal(503, "Agentbook is stopping. Try again once it is back.");
    if (active?.kind === kind) return info(kind);
    if (active) throw refusal(409, "Another agent is being installed on this machine. Wait for it to finish.");
    if (info(kind)?.state === "installed") return info(kind);
    const job: Job = jobs[kind] = { state: "installing", started: new Date().toISOString(), output: "" };
    const controller = new AbortController();
    try { save(); }
    catch (error) { job.state = "failed"; job.error = error.message; throw error; }
    active = { kind, controller };
    changed();
    const output: Output = (text) => {
      job.output = (job.output + text).slice(-16000);
    };
    const timer = setTimeout(() => controller.abort(new Error("Installation timed out after 20 minutes. Retry to finish it.")), 20 * 60e3);
    void (async () => {
      const dir = path.join(root, kind);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const binary = await (perform || install)(kind, dir, output, controller.signal);
      controller.signal.throwIfAborted();
      fs.accessSync(binary.bin, fs.constants.X_OK);
      fs.mkdirSync(bins, { recursive: true, mode: 0o700 });
      const launcher = `#!/bin/sh\n${binary.node ? `PATH=${quote(path.dirname(binary.node))}:"$PATH"\nexport PATH\n` : ""}exec ${quote(binary.bin)} "$@"\n`;
      const target = path.join(bins, RECIPES[kind].bin);
      fs.writeFileSync(`${target}.tmp`, launcher, { mode: 0o700 });
      fs.renameSync(`${target}.tmp`, target);
      installed(kind);
      job.state = "installed";
      output("\nInstalled. " + RECIPES[kind].after + "\n");
    })().catch((error) => {
      job.state = "failed";
      job.error = (controller.signal.aborted ? controller.signal.reason?.message : error.message) || "Installation failed.";
      output(`\n${job.error}\n`);
    }).finally(() => {
      clearTimeout(timer);
      active = null;
      job.finished = new Date().toISOString();
      try { save(); } catch (error) { log(`${kind}: couldn't save installation status: ${error.message}`); }
      changed();
      log(`${kind}: installation ${job.state}`);
    });
    return info(kind);
  }

  async function install(kind: Kind, dir: string, output: Output, signal: AbortSignal) {
    const run = (cmd: string, args: string[], extra: NodeJS.ProcessEnv = {}) => new Promise<void>((resolve, reject) => {
      signal.throwIfAborted();
      const child = spawn(cmd, args, { cwd: dir, env: cleanEnv({ ...extra, CI: "1", NO_COLOR: "1" }), stdio: ["ignore", "pipe", "pipe"], detached: true });
      const kill = () => { try { process.kill(-child.pid, "SIGKILL"); } catch {} };
      signal.addEventListener("abort", kill, { once: true });
      child.stdout.on("data", (b) => output(b.toString()));
      child.stderr.on("data", (b) => output(b.toString()));
      child.on("error", reject);
      child.on("close", (code) => {
        signal.removeEventListener("abort", kill);
        code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} exited ${code ?? "before it finished"}. See the installation output.`));
      });
    });
    const text = async (url: string) => {
      const res = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(120e3)]) });
      if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}): ${url}`);
      const body = await res.text();
      if (body.length > 2e6) throw new Error("The installer metadata is too large.");
      return body;
    };
    const download = async (url: string, dest: string, sha256: string) => {
      if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("The download has no checksum.");
      output(`Downloading ${path.basename(new URL(url).pathname)}…\n`);
      const res = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(300e3)]) });
      if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}): ${url}`);
      const hash = crypto.createHash("sha256");
      const fd = fs.openSync(dest, "w", 0o600);
      let size = 0;
      try {
        for await (const chunk of res.body) {
          size += chunk.length;
          if (size > 512 * 1024 * 1024) throw new Error("The download is too large.");
          hash.update(chunk);
          fs.writeSync(fd, chunk);
        }
      } finally { fs.closeSync(fd); }
      if (hash.digest("hex") !== sha256) throw new Error("The download checksum did not match. Nothing was installed.");
    };
    if (kind === "hermes") {
      const file = path.join(dir, "install.sh");
      fs.writeFileSync(file, await text("https://hermes-agent.nousresearch.com/install.sh"), { mode: 0o600 });
      output("Running Hermes's official installer…\n");
      await run("bash", [file, "--non-interactive", "--verbose"]);
      return { bin: path.join(userHome, ".local", "bin", "hermes") };
    }
    if (kind === "grok") {
      // It installs to ~/.grok/bin, where `grok update` updates it in place, and puts that on the shell's PATH.
      const file = path.join(dir, "install.sh");
      const where = path.join(userHome, ".grok", "bin");
      fs.writeFileSync(file, await text("https://x.ai/cli/install.sh"), { mode: 0o600 });
      output("Running Grok's official installer…\n");
      await run("bash", [file], { GROK_BIN_DIR: where });
      return { bin: path.join(where, "grok") };
    }
    if (kind === "dsh") {
      // The official Node 24 archive brings npm too, and lives only inside this runtime's installation.
      const sums = await text("https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt");
      const entry = sums.split("\n").map((s) => s.trim().split(/\s+/)).find((s) => new RegExp(`^node-v24\\.\\d+\\.\\d+-${platform}-${arch}\\.tar\\.gz$`).test(s[1] || ""));
      if (!entry) throw new Error("Node 24 has no download for this machine.");
      const archive = path.join(dir, "node.tar.gz");
      await download(`https://nodejs.org/dist/latest-v24.x/${entry[1]}`, archive, entry[0]);
      const nodeDir = path.join(dir, "node");
      fs.mkdirSync(nodeDir, { recursive: true });
      await run("tar", ["-xzf", archive, "-C", nodeDir, "--strip-components=1"]);
      const node = path.join(nodeDir, "bin", "node");
      output("Installing DeepSeek Harness with its own Node 24…\n");
      await run(node, [path.join(nodeDir, "lib", "node_modules", "npm", "bin", "npm-cli.js"), "install", "--prefix", dir, "--no-audit", "--no-fund", "@deepseek-ai/dsh"], { PATH: [path.dirname(node), process.env.PATH].join(path.delimiter) });
      return { bin: path.join(dir, "node_modules", ".bin", "dsh"), node };
    }
    // Homebrew publishes checksums for Google's archives on both macOS and Linux; Homebrew itself isn't needed.
    const cask = JSON.parse(await text("https://formulae.brew.sh/api/cask/antigravity-cli.json"));
    const variant = platform === "linux" ? cask.variations?.[`${arch === "arm64" ? "arm64" : "x86_64"}_linux`] : arch === "arm64" ? cask : Object.values(cask.variations || {}).find((v: { url?: string }) => v.url?.includes("/darwin-x64/"));
    if (!variant?.url?.startsWith("https://storage.googleapis.com/antigravity-public/antigravity-cli/")) throw new Error("Antigravity has no verified download for this machine.");
    const archive = path.join(dir, "antigravity.tar.gz");
    await download(variant.url, archive, variant.sha256);
    await run("tar", ["-xzf", archive, "-C", dir]);
    const bin = path.join(dir, "antigravity");
    fs.chmodSync(bin, 0o700);
    return { bin };
  }
  return {
    info, start,
    busy: () => !!active,
    close() {
      closed = true;
      active?.controller.abort(new Error("Agentbook stopped during installation. Retry to finish it."));
    },
  };
}
