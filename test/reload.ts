#!/usr/bin/env node
// agentbook-cli run from a checkout starts itself again when a commit there changes its code (plugin/cli/reload.ts):
// which files count, whose agentbook does it, the watch on a checkout of its own here (a commit to the page, one to
// the code while an agent is mid-turn, code that doesn't build, an agent that never stops), the check on code that
// doesn't build or start, and a successor that waits for the process it replaces.
// Run: node test/reload.ts

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkCode, reloadsFrom, runs, watchCheckout } from "../plugin/cli/reload.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const check = (cond: unknown, label: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (cond()) return true;
  return cond();
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-reload-test-"));

// ---------- which files are its code ----------
check(["plugin/cli/daemon.ts", "plugin/shared/store.ts", "server/main.ts", "package.json", "package-lock.json"].every(runs), "the CLI's code, the server's and the packages are code it runs");
check(!["web/app.tsx", "test/smoke.ts", "docs/plan.md", "plugin/skills/agentbook/SKILL.md", "README.md", "mockups/a.html"].some(runs), "the page, tests, docs and Markdown aren't");

// ---------- whose agentbook ----------
check(reloadsFrom({ repo: REPO, home: path.join(os.homedir(), ".agentbook"), env: {}, bundled: false }) === REPO, "the person's own agentbook, run from this checkout, does it");
check(reloadsFrom({ repo: REPO, home: path.join(tmp, "home"), env: {}, bundled: false }) === null, "one on a data folder of its own (a test's) doesn't");
check(reloadsFrom({ repo: REPO, home: path.join(tmp, "home"), env: { AGENTBOOK_RELOAD: "1" }, bundled: false }) === REPO, "AGENTBOOK_RELOAD=1 turns it on for any");
check(reloadsFrom({ repo: REPO, home: path.join(os.homedir(), ".agentbook"), env: { AGENTBOOK_RELOAD: "0" }, bundled: false }) === null, "AGENTBOOK_RELOAD=0 turns it off");
check(reloadsFrom({ repo: REPO, home: path.join(os.homedir(), ".agentbook"), env: {}, bundled: true }) === null, "the one-file build never does");
check(reloadsFrom({ repo: tmp, home: path.join(os.homedir(), ".agentbook"), env: {}, bundled: false }) === null, "nor code that isn't a checkout of agentbook");

// ---------- the watch, on a checkout of its own ----------
const repo = path.join(tmp, "repo");
const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), text);
};
const git = (...args: string[]) => {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const commit = (file: string, text: string) => {
  write(file, text);
  git("add", "-A");
  git("commit", "-q", "-m", `change ${file}`);
  return git("rev-parse", "HEAD");
};
fs.mkdirSync(repo, { recursive: true });
git("init", "-q", "-b", "main");
write("server/main.ts", "export const a = 1;\n");
write("plugin/cli/a.ts", "export const b = 1;\n");
write("web/app.tsx", "export const c = 1;\n");
git("add", "-A");
git("commit", "-q", "-m", "first");
const own = path.join(os.homedir(), ".agentbook");
check(reloadsFrom({ repo, home: own, env: {}, bundled: false }) === repo, "a checkout of its own reloads, as this one does");
git("config", "agentbook.install", "clone");
check(reloadsFrom({ repo, home: own, env: {}, bundled: false }) === null, "but not once it's marked as an install, which updates itself instead");
git("config", "--unset", "agentbook.install");

function watcher({ busy = () => false, check: checked = async () => null, waitMs = 60e3 }: { busy?: () => boolean; check?: (repo: string) => Promise<string | null>; waitMs?: number } = {}) {
  const seen = { restarts: 0, lines: [] as string[] };
  const w = watchCheckout({ repo, busy, check: checked, restart: () => seen.restarts++, log: (l) => seen.lines.push(l), settleMs: 100, retryMs: 100, waitMs });
  return { ...seen, w, get restarts() { return seen.restarts; }, get lines() { return seen.lines; } };
}

{
  let busy = true;
  const s = watcher({ busy: () => busy });
  check(!!s.w && /starts again by itself when a commit there changes its code/.test(s.lines.join("\n")), "it says it watches, and from which commit");
  commit("web/app.tsx", "export const c = 2;\n");
  await sleep(600);
  check(s.restarts === 0, "a commit to the page only: it doesn't start again (the server builds the page again itself)");
  const to = commit("plugin/cli/a.ts", "export const b = 2;\n");
  await sleep(600);
  check(s.restarts === 0, "a commit to its code while an agent is mid-turn: it waits");
  busy = false;
  check(await until(() => s.restarts === 1), "once no agent is mid-turn, it starts again");
  check(s.lines.some((l) => l.includes(`${to.slice(0, 7)} changed its code (1 file since`)), "and says on which commit, and how much changed");
  commit("server/main.ts", "export const a = 2;\n");
  await sleep(600);
  check(s.restarts === 1, "it starts again once: what comes after is the next one's");
}
{
  let why: string | null = "it doesn't build: Expected \";\" (server/main.ts:1)";
  const s = watcher({ check: async () => why });
  const bad = commit("server/main.ts", "export const a = ;\n");
  check(await until(() => s.lines.some((l) => /can't start again on it/.test(l))), "code that doesn't build: it says so in its log, and why");
  check(s.restarts === 0 && s.lines.some((l) => l.includes(bad.slice(0, 7)) && l.includes("server/main.ts:1")), "and goes on running what it runs");
  why = null;
  commit("server/main.ts", "export const a = 3;\n");
  check(await until(() => s.restarts === 1), "the next commit, whose code builds, starts it again");
}
{
  const s = watcher({ busy: () => true, waitMs: 500 });
  commit("plugin/cli/a.ts", "export const b = 3;\n");
  await sleep(300);
  check(s.restarts === 0, "with agents always at work, it waits a while");
  check(await until(() => s.restarts === 1, 3000), "but not longer than its wait: then it starts again anyway");
}
{
  // A commit landing while its code is checked: checked again, and started once.
  let checks = 0;
  const s = watcher({ check: async () => (checks++, await sleep(600), null) });
  commit("server/main.ts", "export const a = 4;\n");
  await sleep(300);
  const last = commit("web/app.tsx", "export const c = 3;\n");
  check(await until(() => s.restarts >= 1, 4000) && checks === 2, `a commit landing while it checks: it checks the new one too, then starts again (checked ${checks} times)`);
  await sleep(800);
  check(s.restarts === 1 && s.lines.some((l) => l.includes(last.slice(0, 7))), "once, on the newest commit");
}
{
  const s = watcher();
  git("checkout", "-q", "-b", "other", "HEAD~2");
  check(await until(() => s.restarts === 1), "another branch checked out, whose code differs: it starts again");
  git("checkout", "-q", "main");
}

// ---------- the check on the checkout's code ----------
const code = path.join(tmp, "code");
const put = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(code, file)), { recursive: true });
  fs.writeFileSync(path.join(code, file), text);
};
put("entry.ts", 'import { b } from "./plugin/cli/b.ts";\nconsole.log(b);\n');
put("plugin/cli/b.ts", "export const b: number = 1;\n");
put("plugin/cli/main.mjs", 'if (process.argv[2] === "--version") console.log("agentbook-cli 9.9.9");\n');
check((await checkCode(code)) === null, "code that builds and starts passes");
put("plugin/cli/b.ts", "export const b: number = ;\n");
const broken = await checkCode(code);
check(/^it doesn't build: .*plugin\/cli\/b\.ts:1/.test(broken || ""), `a half-written file doesn't (${broken})`);
put("plugin/cli/b.ts", "export const b: number = 1;\n");
put("entry.ts", 'import { b } from "./plugin/cli/gone.ts";\nconsole.log(b);\n');
check(/^it doesn't build: Could not resolve/.test((await checkCode(code)) || ""), "nor an import of a file that isn't there");
put("entry.ts", 'import { b } from "./plugin/cli/b.ts";\nconsole.log(b);\n');
put("plugin/cli/main.mjs", 'throw new Error("no such export: thing");\n');
const dead = await checkCode(code);
check(/^it doesn't start: .*no such export: thing/.test(dead || ""), `nor code that throws as it starts (${dead})`);
const real = await checkCode(REPO);
check(real === null, `this checkout's own code passes (${real})`);

// ---------- its successor ----------
// A process that hands over to the next (startAgain), which proves the first was gone before it began.
const marks = path.join(tmp, "marks");
const script = path.join(tmp, "hand-over.mjs");
fs.writeFileSync(
  script,
  `import fs from "node:fs";
const [, , step, marks] = process.argv;
if (step === "first") {
  const { startAgain } = await import(${JSON.stringify(pathToFileURL(path.join(REPO, "plugin", "cli", "reload.ts")).href)});
  // As webui.ts does once its server has loaded.
  delete process.env.AGENTBOOK_SECRET_KEY;
  fs.writeFileSync(marks + ".first", String(process.pid));
  setInterval(() => {}, 1000);
  setTimeout(() => startAgain({ argv: [process.argv[1], "second", marks], log: marks + ".log" }), 200);
} else {
  const first = Number(fs.readFileSync(marks + ".first", "utf8"));
  let alive = true;
  try { process.kill(first, 0); } catch { alive = false; }
  fs.writeFileSync(marks + ".second", JSON.stringify({ pid: process.pid, firstAlive: alive, cwd: process.cwd(), session: process.env.CLAUDE_CODE_SESSION_ID || null, key: process.env.AGENTBOOK_SECRET_KEY || null }));
}
`,
);
const first = spawn(process.execPath, [script, "first", marks], { stdio: "ignore", env: { ...process.env, CLAUDE_CODE_SESSION_ID: "a-session", AGENTBOOK_SECRET_KEY: "the-key" } });
const ended = new Promise<string | null>((r) => first.on("exit", (_, signal) => r(signal)));
check(await until(() => fs.existsSync(marks + ".second"), 8000), "its successor starts");
const second = fs.existsSync(marks + ".second") ? JSON.parse(fs.readFileSync(marks + ".second", "utf8")) : {};
check((await ended) === "SIGTERM" && second.firstAlive === false && second.pid !== first.pid, "after the one it replaces stopped, as agentbook stop stops it");
check(second.cwd === os.homedir() && second.session === null, "in the home folder, with the person's environment, not a session's");
check(second.key === "the-key", "and the server's secret key it was started with, which the server took out of its environment");

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
