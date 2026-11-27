#!/usr/bin/env node
// What a session changed: the diff engine on its own, then a real server following a transcript the way
// Claude Code writes it (edits, a new file, commands that change files, a commit, a subagent), and what the
// page gets for it. Run: node test/changes.ts

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyHunks, argEdits, codexEdits, diffTexts, fileChange, parsePatch, parseUnified, sizeOf, statesOf } from "../plugin/cli/changes.ts";
import { postForOthers } from "../server/policy.ts";
import { spawnAgentbook, testPort } from "./harness.ts";
import { stateOf } from "./harness-state.ts";
import type { Json } from "./harness-types.ts";

const TEST = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST, "..", "plugin");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-changes-"));
const PORT = testPort(5300);
const URL = `http://127.0.0.1:${PORT}`;
const env = {
  ...process.env,
  AGENTBOOK_HOME: HOME,
  AGENTBOOK_PORT: String(PORT),
  AGENTBOOK_URL: URL,
  AGENTBOOK_CODEX: "0",
  AGENTBOOK_TERMINAL: "0",
  AGENTBOOK_CLAUDE: path.join(TEST, "fake-claude.ts"),
  FAKE_CLAUDE_DIR: path.join(HOME, "fake-claude"),
  CLAUDE_CONFIG_DIR: path.join(HOME, "claude"),
  CLAUDE_PLUGIN_ROOT: ROOT,
  CLAUDE_CODE_ENTRYPOINT: "cli",
  AGENTBOOK_RUNTIME_MS: "300",
  AGENTBOOK_SNAPSHOT_MS: "300",
};
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_OWNER"]) delete env[k];
fs.mkdirSync(env.FAKE_CLAUDE_DIR);

let failures = 0;
const check = (cond: unknown, label: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async <T>(fn: () => T | Promise<T>, ms = 5000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(100);
  }
};
const lines = (n: number, f = (i: number) => `line ${i + 1}`) => Array.from({ length: n }, (_, i) => f(i)).join("\n") + "\n";

/* ---------- the engine ---------- */

{
  let bad = 0;
  for (let t = 0; t < 200; t++) {
    const x = Array.from({ length: 1 + Math.floor(Math.random() * 50) }, () => "abcde"[Math.floor(Math.random() * 5)]);
    const y = x.filter(() => Math.random() > 0.2).map((l) => (Math.random() > 0.85 ? l + "!" : l));
    if (Math.random() > 0.5) y.splice(Math.floor(Math.random() * (y.length + 1)), 0, "new");
    const X = x.join("\n") + "\n";
    const Y = y.length ? y.join("\n") + "\n" : "";
    const h = diffTexts(X, Y);
    if (applyHunks(X, h) !== Y || applyHunks(Y, h, true) !== X) bad++;
  }
  check(!bad, "a diff applies forwards to its old text and backwards to its new one");

  const a = lines(60);
  const b = a.replace("line 10\n", "line ten\n");
  const c = b.replace("line 50\n", "");
  const ops = [{ hunks: diffTexts(a, b) }, { hunks: diffTexts(b, c) }];
  const K = statesOf(ops, () => c);
  const net = fileChange(ops, K);
  check(K[0] === a && net.exact && sizeOf(net.hunks).add === 1 && sizeOf(net.hunks).del === 2, "with no saved copy, the file before is rebuilt from the file now, undoing each edit");
  const moved = statesOf(ops, () => c.replace("line 9\n", "line nine\n"));
  check(moved[0] === undefined && !fileChange(ops, moved).exact, "when the file now has other changes where the edits were, the edits show one by one");
  const away = statesOf(ops, () => c.replace("line 30\n", "line thirty\n"));
  check(away[0] !== undefined && sizeOf(fileChange(ops, away).hunks).add === 1, "other changes elsewhere in the file stay out of the diff");
  const outside = [{ before: a, hunks: diffTexts(a, b) }, { before: b.replace("line 20\n", "line twenty\n"), hunks: diffTexts(b, c) }];
  check(fileChange(outside, statesOf(outside)).outside, "a file that changed between two edits says so");

  const G = "diff --" + "git";
  const files = parseUnified(`${G} a/x.js b/x.js\n--- a/x.js\n+++ b/x.js\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n${G} a/n.txt b/n.txt\nnew file mode 100644\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1 @@\n+hi\n${G} a/old.md b/new.md\nsimilarity index 100%\nrename from old.md\nrename to new.md\n`);
  check(files.length === 3 && files[0].path === "x.js" && sizeOf(files[0].hunks).add === 1 && files[1].kind === "create" && files[2].kind === "rename" && files[2].path === "new.md", "unified diffs parse into files: edited, new, renamed");
  const patch = parsePatch("*** Begin Patch\n*** Update File: s.py\n@@ def f():\n     x = 1\n-    y = 2\n+    y = 3\n*** Add File: t.txt\n+hi\n*** End Patch");
  check(applyHunks("def f():\n    x = 1\n    y = 2\n", patch[0].hunks) === "def f():\n    x = 1\n    y = 3\n" && patch[1].content === "hi\n", "apply_patch patches parse, and their hunks apply without line numbers");

  const cx = codexEdits({ changes: [{ path: "/w/a.js", kind: "update", diff: "@@ -1 +1 @@\n-a\n+b\n" }, { path: "b.js", kind: { type: "add" }, diff: "x\ny\n" }] }, "/w");
  check(cx[0].abs === "/w/a.js" && cx[0].add === 1 && cx[0].del === 1 && cx[1].abs === "/w/b.js" && cx[1].kind === "create" && cx[1].add === 2, "Codex's file changes: an edit's diff, and a new file's text");
  const hm = argEdits("patch", JSON.stringify({ mode: "replace", path: "src/x.py", old_string: "a = 1", new_string: "a = 2" }), "/w");
  const oc = argEdits("write", { path: "/w/y.txt", content: "one\ntwo\n" }, "/w");
  check(hm[0]?.abs === "/w/src/x.py" && hm[0].add === 1 && oc[0]?.add === 2 && !argEdits("read_file", { path: "z" }, "/w").length, "Hermes's and OpenClaw's edits come from their tools' arguments");

  // A post cut short to what the check needs, so it's no type of agentbook's.
  const post: Json = { updates: [{ text: "Changed server/secret.mjs, +3", changes: { files: 1, add: 3, del: 0 } }], show_work: false, visibility: "public" };
  const others = postForOthers(post, { visibility: "public" }, "me");
  check(others.updates[0].text === "Changed server/secret.mjs, +3", "others who see a thread see which files a turn changed: whoever sees it sees its work");
}

/* ---------- a session on a real server ---------- */

const project = path.join(HOME, "dev", "app");
fs.mkdirSync(project, { recursive: true });
const git = (args: string[], date?: string) => spawnSync("git", ["-C", project, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { encoding: "utf8", env: { ...process.env, ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) } });
const file = (rel: string) => path.join(project, rel);
const put = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(file(rel)), { recursive: true });
  fs.writeFileSync(file(rel), text);
};
// What the files were, and what the session leaves them as.
const A0 = lines(8);
const A1 = A0.replace("line 3\n", "line three\n");
const B0 = lines(400, (i) => `const v${i} = ${i};`);
const B1 = B0.replace("const v10 = 10;\n", "const v10 = 11;\n");
const B2 = B1.replace("const v300 = 300;\n", "const v300 = 300;\nconst extra = true;\n");
const H0 = lines(200, (i) => `h${i}`);
const H1 = H0.replace("h5\n", "h-five\n");
const H2 = H1.replace("h150\n", "");
const D0 = "port = 80\n";
const D1 = "port = 8080\n";
put("a.js", A0);
put("b.js", B0);
put("h.js", H0);
put("d.txt", D0);
git(["init", "-q", "-b", "main"]);
git(["add", "-A"]);
git(["commit", "-q", "-m", "start"]);

// A transcript, the way Claude Code writes it.
const T = path.join(HOME, "sess-a.jsonl");
const now = () => new Date().toISOString();
const write = (f: string, ...entries: object[]) => fs.appendFileSync(f, entries.map((e) => JSON.stringify({ timestamp: now(), ...e }) + "\n").join(""));
const prompt = (text: string) => ({ type: "user", message: { content: text } });
const use = (id: string, name: string, input: object) => ({ type: "assistant", message: { model: "claude-opus-5-5", content: [{ type: "tool_use", id, name, input }] } });
const done = (id: string, r: object, content: unknown = "ok") => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content }] }, toolUseResult: r });
// An Edit's toolUseResult: `small`, a file Claude Code sends whole (originalFile).
const edited = (abs: string, before: string, after: string, small?: boolean) => ({ filePath: abs, oldString: "", newString: "", originalFile: small ? before : null, structuredPatch: diffTexts(before, after), userModified: false, replaceAll: false });
const ran = (changed: [abs: string, before: string, after: string][], stdout = "") => ({ stdout, stderr: "", interrupted: false, bashEditDiff: { files: changed.map(([abs, before, after]) => ({ filePath: abs, hunks: diffTexts(before, after) })), moreFiles: 0, changedFiles: changed.map(([abs]) => abs) } });
fs.writeFileSync(T, "");

const server = spawnAgentbook({ env, stdio: process.env.DEBUG ? "inherit" : "ignore" });
let COOKIE = "";
const get = async (p: string) => {
  const r = await fetch(URL + p, { headers: { cookie: COOKIE } });
  return { status: r.status, ...((await r.json().catch(() => ({}))) as Json) };
};
const hook = (event: string, input: object, pid: number) => spawnSync(process.execPath, [path.join(ROOT, "hooks", "hook.ts"), event], { input: JSON.stringify({ cwd: project, ...input }), env: { ...env, AGENTBOOK_PID: String(pid), AGENTBOOK_LABEL: `s${pid}` }, encoding: "utf8", timeout: 15000 });
try {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(URL + "/api/health")).ok) break;
    } catch {}
    await sleep(100);
  }
  const setup = await fetch(URL + "/api/auth/test-person", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "tester" }) });
  COOKIE = (setup.headers.get("set-cookie") || "").split(";")[0];
  hook("SessionStart", { session_id: "sess-a", source: "startup", transcript_path: T }, 8101);
  hook("UserPromptSubmit", { session_id: "sess-a", prompt: "make the change", transcript_path: T }, 8101);

  // ---------- turn 1: edits, a new file, commands, a commit ----------
  const notes = path.join(os.homedir(), ".claude", "projects", `agentbook-test-${process.pid}`, "memory", "notes.md"); // never written: its text is in the transcript
  const scratch = path.join(os.tmpdir(), `agentbook-scratch-${process.pid}.txt`);
  write(T, prompt("make the change"));
  write(T, use("e1", "Edit", { file_path: file("a.js") }), done("e1", edited(file("a.js"), A0, A1, true)));
  write(T, use("e2", "Edit", { file_path: file("b.js") }), done("e2", edited(file("b.js"), B0, B1, false)));
  write(T, use("e3", "Edit", { file_path: file("b.js") }), done("e3", edited(file("b.js"), B1, B2, false)));
  write(T, use("e4", "Write", { file_path: file("c.css") }), done("e4", { type: "create", filePath: file("c.css"), content: "a {}\nb {}\n", structuredPatch: [], originalFile: null }));
  write(T, use("e5", "Edit", { file_path: file("h.js") }), done("e5", edited(file("h.js"), H0, H1, false)));
  write(T, use("e6", "Edit", { file_path: file("h.js") }), done("e6", edited(file("h.js"), H1, H2, false)));
  write(T, use("e7", "Write", { file_path: notes }), done("e7", { type: "create", filePath: notes, content: "remember\n", structuredPatch: [], originalFile: null }));
  write(T, use("e8", "Write", { file_path: scratch }), done("e8", { type: "create", filePath: scratch, content: "tmp\n", structuredPatch: [], originalFile: null }));
  write(T, use("e9", "Edit", { file_path: file(".env") }), done("e9", edited(file(".env"), "KEY=old\n", "KEY=SECRETX-new\n", true)));
  write(T, use("b1", "Bash", { command: "sed -i '' 's/80/8080/' d.txt", description: "Change the port" }), done("b1", ran([[file("d.txt"), D0, D1]])));
  write(T, use("b2", "Bash", { command: "npm run build", description: "Build it" }), done("b2", ran([[file("e.txt"), "", "built\n"]])));
  // The files on disk, as the session left them (h.js since changed by someone else, where it edited).
  put("a.js", A1);
  put("b.js", B2);
  put("c.css", "a {}\nb {}\n");
  put("d.txt", D1);
  put("e.txt", "built\n");
  put("h.js", H2.replace("h-five\n", "h-5\n"));
  put(".env", "KEY=SECRETX-new\n");
  write(T, use("b3", "Bash", { command: "git add a.js b.js c.css && git commit -m 'Turn one'", description: "Commit it" }));
  const committed = git(["add", "a.js", "b.js", "c.css"]).status === 0 && git(["commit", "-q", "-m", "Turn one"], now()).status === 0;
  write(T, done("b3", { stdout: "", stderr: "", interrupted: false }));
  const sha = git(["rev-parse", "HEAD"]).stdout.trim();

  const steps = await until(async () => {
    const r = await get("/api/sessions/sess-a/steps");
    return r.steps?.find((x) => x.id === "b3")?.done ? r : null;
  });
  const step = (id: string) => steps?.steps.find((x) => x.id === id);
  check(step("e1")?.files?.[0]?.path === "a.js" && step("e1").files[0].add === 1 && step("e1").files[0].del === 1, "an edit step says what it changed, and how much");
  check(step("b1")?.files?.[0]?.kind === "command" && step("b1").files[0].path === "d.txt", "a command's step lists the files it changed");

  const all = await get("/api/sessions/sess-a/changes?scope=all");
  const f = (p: string) => all.files?.find((x) => x.path === p);
  check(f("b.js")?.exact && f("b.js").add === 2 && f("b.js").del === 1 && f("b.js").edits === 2, "a big file's two edits read as one diff, rebuilt from the file on disk");
  check(f("a.js")?.exact && f("c.css")?.kind === "create" && f("c.css").add === 2, "a small file's diff, and a new file's");
  check(f("h.js") && !f("h.js").exact && f("h.js").edits === 2, "a file changed since, where it was edited, shows its edits one by one");
  check(f("d.txt")?.by === "command" && f("e.txt")?.by === "command", "files a command changed are the session's, in a folder it has to itself");
  check(f(notes.replace(os.homedir(), "~"))?.elsewhere || all.files?.some((x) => x.elsewhere && x.path.endsWith("memory.md")), "a file outside its folder is listed apart");
  check(!all.files?.some((x) => x.path.includes("agentbook-scratch")), "scratch files in a temporary folder are left out");
  const envf = f(".env");
  check(envf?.secret && envf.nodiff && !JSON.stringify(all).includes("SECRETX"), `a file that holds secrets is listed as changed, its lines kept on the machine (${JSON.stringify(envf)})`);
  const envOne = await get("/api/sessions/sess-a/changes/file?path=.env&scope=all");
  check(envOne.secret && !envOne.hunks?.length && !JSON.stringify(envOne).includes("SECRETX"), `asked for its diff, there's none, and why (${JSON.stringify(envOne).slice(0, 160)})`);
  check(all.totals?.files === 7, `the totals count files in its folder only (got ${all.totals?.files})`);
  check(committed && all.commits?.some((c) => c.sha === sha && c.subject === "Turn one"), "the commit its command made is listed, though the output didn't name it");

  const fileDiff = await get("/api/sessions/sess-a/changes/file?scope=all&path=b.js");
  check(fileDiff.hunks?.length === 2 && fileDiff.hunks[0].oldStart > 1, "a file's diff comes with its hunks and line numbers");
  const stepDiff = await get("/api/sessions/sess-a/steps/e3/diff");
  check(stepDiff.files?.[0]?.path === "b.js" && stepDiff.files[0].add === 1 && stepDiff.files[0].del === 0, "a step's diff is what that one edit did");
  const commit = await get(`/api/sessions/sess-a/commits/${sha.slice(0, 7)}`);
  check(commit.files?.length === 3 && commit.files.some((x) => x.path === "c.css" && x.kind === "create"), "a commit opens to its change");
  check((await get("/api/sessions/sess-a/commits/0000000")).status === 404, "a commit it didn't make isn't shown");

  // ---------- the turn ends: the post says what changed, once ----------
  hook("Stop", { stop_hook_active: false, last_assistant_message: "Done.", transcript_path: T }, 8101);
  const line = await until(async () => (await stateOf(get)).sessions.find((s) => s.id === "sess-a")?.updates.find((u) => u.changes), 6000);
  check(line?.text === "Changed 7 files, +9 −6" && line.changes.turn === 1, `when a turn ends, the post says what it changed (got "${line?.text}")`);
  const reach = line?.changes?.reach;
  check(reach?.changed === 7 && reach.folders[0].dir === "." && reach.folders[0].files.some((x) => x.path === "b.js" && x.changed && x.add === 2), `and how far it reaches, from git: the repo by folder, with what it changed (got ${JSON.stringify(reach)?.slice(0, 200)})`);
  hook("UserPromptSubmit", { session_id: "sess-a", prompt: "anything else?", transcript_path: T }, 8101);
  hook("Stop", { stop_hook_active: false, last_assistant_message: "No.", transcript_path: T }, 8101);
  await sleep(2500);
  check((await stateOf(get)).sessions.find((s) => s.id === "sess-a")?.updates.filter((u) => u.changes).length === 1, "a turn that changed nothing new adds no line");
  const stats = await until(async () => (await stateOf(get)).sessions.find((s) => s.id === "sess-a")?.stats?.files, 4000);
  check(stats === 7, "the post's summary counts the files it changed");

  // ---------- turn 2: a subagent's edits, and another session in the folder ----------
  hook("SessionStart", { session_id: "sess-b", source: "startup" }, 8102);
  hook("UserPromptSubmit", { session_id: "sess-b", prompt: "look around" }, 8102);
  await sleep(50);
  hook("UserPromptSubmit", { session_id: "sess-a", prompt: "and the tests", transcript_path: T }, 8101);
  write(T, prompt("and the tests"));
  write(T, use("ag1", "Agent", { description: "Write the tests" }));
  const subs = path.join(HOME, "sess-a", "subagents");
  fs.mkdirSync(subs, { recursive: true });
  fs.writeFileSync(path.join(subs, "agent-x.meta.json"), JSON.stringify({ toolUseId: "ag1" }));
  write(path.join(subs, "agent-x.jsonl"), { ...use("s1", "Write", { file_path: file("t.test.js") }), isSidechain: true }, { ...done("s1", { type: "create", filePath: file("t.test.js"), content: "test()\n", structuredPatch: [], originalFile: null }), isSidechain: true });
  put("t.test.js", "test()\n");
  write(T, done("ag1", { status: "completed", agentId: "x" }));
  write(T, use("b4", "Bash", { command: "npm test", description: "Run the tests" }), done("b4", ran([[file("other.txt"), "", "someone else's\n"]])));
  write(T, use("b5", "Bash", { command: "npm install left-pad", description: "Add left-pad" }), done("b5", ran([[file("package.json"), "{}\n", '{ "left-pad": "1" }\n']])));
  const turn2 = await until(async () => {
    const r = await get("/api/sessions/sess-a/changes?scope=2");
    return r.files?.length >= 2 ? r : null;
  });
  const t2 = (p) => turn2?.files.find((x) => x.path === p);
  check(t2("t.test.js")?.kind === "create", "a subagent's edits are the session's too");
  const agentStep = (await get("/api/sessions/sess-a/steps")).steps?.find((x) => x.id === "ag1");
  check(agentStep?.files?.[0]?.path === "t.test.js", "and count on the step that started it");
  check(t2("package.json")?.by === "command" && !t2("other.txt"), "with another session in the folder, a command's change counts only if it names the file or writes files for a living");
  check(turn2 && !turn2.files.some((x) => x.path === "a.js") && turn2.latest === 2, "a turn's changes are that turn's only");
  const auto = await get("/api/sessions/sess-a/changes");
  check(auto.scope === "2" && auto.turns > 1, "while it runs, the post opens on the turn it's on");
} finally {
  server.kill();
}
console.log(failures ? `\n${failures} check(s) failed\n(test data in ${HOME})` : "\nAll checks passed");
if (!failures) fs.rmSync(HOME, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
