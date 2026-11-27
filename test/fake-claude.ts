#!/usr/bin/env node
// A stand-in for the `claude` command in tests. It records how agentbook called it (FAKE_CLAUDE_DIR/calls.jsonl)
// and keeps the background sessions in FAKE_CLAUDE_DIR/agents.json, the way `claude agents --json --all`
// reports them. The next new session's id can be set in FAKE_CLAUDE_DIR/next.txt, and how long it takes to start in
// FAKE_CLAUDE_DIR/slow.txt. Like Claude Code, a background session keeps its prompt and the options it started with
// ($CLAUDE_CONFIG_DIR/jobs/<id>/state.json), and resuming one with options of its own starts a copy (so does the next
// resume, whatever it's passed, while FAKE_CLAUDE_DIR/copy.txt is there). `attach` takes
// Esc, which interrupts a busy session's turn (logged as an "esc" call), or closes a panel it waits on. Like Claude Code,
// an interrupt goes in the session's transcript (`transcript` in its row), and one with a shell running (`shell`) is
// still listed as busy after it. FAKE_CLAUDE_DIR/esc-silent: the screen doesn't show it. FAKE_CLAUDE_DIR/esc-ignored:
// the session hangs, and Esc doesn't reach it.
// `claude -p --input-format stream-json` answers the SDK's `initialize` with the slash commands in
// FAKE_CLAUDE_DIR/commands.json. Teleporting a cloud session registers it with agentbook. A folder named
// "untrusted…" isn't trusted until $CLAUDE_CONFIG_DIR/.claude.json trusts it, as Claude Code's trust prompt does.
// `--resume <id> --fork-session --bg` starts a new session with a copy of the other's transcript (a side thread).
// While FAKE_CLAUDE_DIR/logged-out is there, Claude Code has no login: a background session it starts or resumes stops
// before its turn, listed as blocked and saved as "Login expired", and runs no hook.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// A background session, as `claude agents --json --all` lists it; `exitAt`: when a stopped one's process is gone.
interface BgSession {
  id: string;
  sessionId: string;
  kind?: string;
  state?: string;
  status?: string;
  cwd?: string;
  pid?: number;
  name?: string;
  exitAt?: number;
  // A shell is running in it.
  shell?: boolean;
  transcript?: string;
  waitingFor?: string;
  [field: string]: unknown;
}

const dir = process.env.FAKE_CLAUDE_DIR;
const file = path.join(dir, "agents.json");
const load = () => {
  let list: BgSession[] = [];
  try {
    list = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {}
  // A stopped session's process is gone once its time to exit has passed (see stop).
  for (const a of list.filter((x) => x.exitAt && x.exitAt <= Date.now())) {
    Object.assign(a, { state: "done" });
    for (const k of ["pid", "status", "exitAt"]) delete a[k];
  }
  return list;
};
// In one step: a test reading it during a plain write sees it empty.
const save = (list: BgSession[]) => {
  const tmp = `${file}.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 1));
  fs.renameSync(tmp, file);
};
const args = process.argv.slice(2);
const pick = (...keys: string[]) => Object.fromEntries(keys.map((k) => [k, process.env[k]]));
fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ args, cwd: process.cwd(), env: pick("AGENTBOOK_LAUNCH_ID", "AGENTBOOK_LABEL", "AGENTBOOK_CHANNEL", "CLAUDECODE", "CLAUDE_PROJECT_DIR") }) + "\n");

// The SDK's `initialize`, as agentbook asks it for a session's slash commands: `claude -p --input-format stream-json …`
// answers with FAKE_CLAUDE_DIR/commands.json (Claude Code's rows), and waits to be ended.
if (args.includes("-p") && args.includes("--input-format")) {
  let buf = "";
  process.stdin.on("data", (d) => {
    buf += d;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (m.type !== "control_request" || m.request?.subtype !== "initialize") continue;
      const commands = JSON.parse(fs.readFileSync(path.join(dir, "commands.json"), "utf8"));
      process.stdout.write(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: { commands } } }) + "\n");
    }
  });
  process.stdin.on("end", () => process.exit(0));
  await new Promise(() => {});
}
// A headless run agentbook-cli asks to send another session a message (its nudge): `claude -p "<prompt>" --allowedTools
// SendMessage --output-format stream-json`. Like Claude Code, the tool's result says the message is in that session's
// inbox; while FAKE_CLAUDE_DIR/nudge-refused is there, the tool fails instead.
if (args.includes("-p") && args[args.indexOf("--allowedTools") + 1] === "SendMessage") {
  const refused = fs.existsSync(path.join(dir, "nudge-refused"));
  const content = refused ? "No agent or session is named that." : JSON.stringify({ success: true, message: "in that session's inbox, not yet read by its Claude" });
  process.stdout.write(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_fake", ...(refused ? { is_error: true } : {}), content: [{ type: "text", text: content }] }] } }) + "\n");
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result: "sent" }) + "\n");
  process.exit(0);
}
// A follow-up for a cloud session: `claude -p "<message>" --cloud <id> --output-format json`.
if (args.includes("--cloud") && args.includes("-p")) {
  const id = args[args.indexOf("--cloud") + 1];
  process.stdout.write(JSON.stringify({ ok: true, session_id: id, url: `https://claude.ai/code/${id}` }));
  process.exit(0);
}
// Teleport: `claude --teleport <id>` copies a cloud session into a session here, in the folder it's run in.
// agentbook's plugin registers it as it starts, with the launch it was started for, as the hook does.
if (args.includes("--teleport")) {
  const id = args[args.indexOf("--teleport") + 1];
  const base = process.env.AGENTBOOK_URL || `http://127.0.0.1:${process.env.AGENTBOOK_PORT || 4320}`;
  const r = await fetch(`${base}/api/hello`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ proc: `teleport-${process.pid}`, label: "teleported", session_id: `local-${id}`, cwd: process.cwd(), launch: process.env.AGENTBOOK_LAUNCH_ID }) });
  process.exit(r.ok ? 0 : 1);
}
if (args[0] === "--version") {
  process.stdout.write("2.1.316 (Claude Code)\n");
  process.exit(0);
}
// `claude auth login`, as Claude Code 2.1.319 does it with no terminal: it prints a link to sign in at (claude.ai shows
// a code after), wrapped as a terminal hyperlink, and reads one `code#state` line. The code in
// FAKE_CLAUDE_DIR/login-code.txt signs it in: Claude Code's login, where it keeps it off macOS
// ($CLAUDE_CONFIG_DIR/.credentials.json), is written, and it exits 0. Anything else ends it, failed, as Claude Code
// does. FAKE_CLAUDE_DIR/login-silent: it never prints its link. What it got goes in FAKE_CLAUDE_DIR/login-got.txt, and
// BROWSER as it ran in FAKE_CLAUDE_DIR/login-browser.txt.
if (args[0] === "auth" && args[1] === "login") {
  fs.writeFileSync(path.join(dir, "login-browser.txt"), process.env.BROWSER || "");
  const link = `https://claude.com/cai/oauth/authorize?code=true&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=fake${process.pid}`;
  if (!fs.existsSync(path.join(dir, "login-silent"))) process.stdout.write(`Opening browser to sign in\u2026\nIf the browser didn't open, visit: \x1b]8;;${link}\x07${link}\x1b]8;;\x07\nPaste code here if prompted > `);
  let buf = "";
  process.stdin.on("data", (d) => {
    buf += d;
    const i = buf.indexOf("\n");
    if (i < 0) return;
    const got = buf.slice(0, i).trim();
    fs.writeFileSync(path.join(dir, "login-got.txt"), got);
    let want = null;
    try {
      want = fs.readFileSync(path.join(dir, "login-code.txt"), "utf8").trim();
    } catch {}
    if (got && got === want) {
      const cfg = process.env.CLAUDE_CONFIG_DIR;
      fs.mkdirSync(cfg, { recursive: true });
      fs.writeFileSync(path.join(cfg, ".credentials.json"), JSON.stringify({ claudeAiOauth: { signedInAt: Date.now() } }));
      process.stdout.write("\nLogin successful.\n");
      process.exit(0);
    }
    process.stderr.write("Login failed: That code wasn't accepted. It may be incomplete, expired, already used, or from an earlier sign-in attempt. Sign in again to get a new code.\n");
    process.exit(1);
  });
  process.stdin.on("end", () => process.exit(1));
  await new Promise(() => {});
}
if (args[0] === "agents") {
  // FAKE_CLAUDE_DIR/agents-fails: it can't list them. FAKE_CLAUDE_DIR/agents-slow: it takes that many ms, and says what it
  // saw when it was asked.
  if (fs.existsSync(path.join(dir, "agents-fails"))) {
    console.error("Couldn't list them");
    process.exit(1);
  }
  const listed = JSON.stringify(load().map(({ exitAt, ...a }) => a));
  const slow = path.join(dir, "agents-slow");
  if (fs.existsSync(slow)) await new Promise((r) => setTimeout(r, Number(fs.readFileSync(slow, "utf8"))));
  process.stdout.write(listed);
  process.exit(0);
}
if (args[0] === "stop") {
  // FAKE_CLAUDE_DIR/stop-fails: Claude Code couldn't stop it (a test removes the file to let it).
  if (fs.existsSync(path.join(dir, "stop-fails"))) {
    console.error("Couldn't stop it");
    process.exit(1);
  }
  const list = load();
  const a = list.find((x) => x.id === args[1]);
  if (!a) {
    console.error(`No session ${args[1]}`);
    process.exit(1);
  }
  // Like Claude Code: a stopped session is listed as done, without a process. FAKE_CLAUDE_DIR/slow-stop.txt: how
  // long its process takes to exit (ms), once: until then it's listed as stopped with its process, and resuming it
  // starts a copy.
  const slow = path.join(dir, "slow-stop.txt");
  if (fs.existsSync(slow)) {
    Object.assign(a, { state: "stopped", status: "idle", exitAt: Date.now() + Number(fs.readFileSync(slow, "utf8")) });
    fs.rmSync(slow, { force: true });
  } else {
    Object.assign(a, { state: "done" });
    delete a.pid;
    delete a.status;
  }
  save(list);
  console.log(`stopped ${a.id}`);
  process.exit(0);
}
// `claude attach <id>` in a terminal: it draws the session, and Esc interrupts a busy one's turn.
if (args[0] === "attach") {
  const a = load().find((x) => x.id === args[1]);
  if (!a?.pid) {
    console.error(`No running session ${args[1]}`);
    process.exit(1);
  }
  process.stdout.write(`\x1b[2J\x1b[H❯ ${a.name}\r\n${a.status === "busy" ? "esc to interrupt" : ""}\r\n`);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.on("data", (d) => {
    if (!d.includes(0x1b)) return;
    const list = load();
    const me = list.find((x) => x.id === args[1]);
    if (me.status !== "busy" && me.status !== "waiting") return;
    fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ args: ["esc", me.id] }) + "\n");
    if (fs.existsSync(path.join(dir, "esc-ignored"))) return;
    if (!me.shell) me.status = "idle";
    delete me.waitingFor;
    save(list);
    if (me.transcript) fs.appendFileSync(me.transcript, JSON.stringify({ type: "user", timestamp: new Date().toISOString(), sessionId: me.sessionId, message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } }) + "\n");
    if (!fs.existsSync(path.join(dir, "esc-silent"))) process.stdout.write("\x1b[3;1H  ⎿  Interrupted · What should Claude do instead?\r\n");
  });
  process.stdin.on("end", () => process.exit(0));
  process.on("SIGHUP", () => process.exit(0));
} else if (args.includes("--bg")) {
  const trusted = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, ".claude.json"), "utf8")).projects[process.cwd()].hasTrustDialogAccepted === true;
    } catch {
      return false;
    }
  };
  if (/untrusted/.test(process.cwd()) && !trusted()) {
    console.error(`Workspace not trusted. Run \`claude\` in ${process.cwd()} once and accept the trust prompt, then retry.`);
    process.exit(1);
  }
  const list = load();
  const r = args.indexOf("--resume");
  const add = (sessionId: string) => list.push({ id: sessionId.slice(0, 8), sessionId, kind: "background", state: "working", status: "busy", cwd: process.cwd(), pid: 4242, name: "test" });
  const jobs = path.join(process.env.CLAUDE_CONFIG_DIR || dir, "jobs");
  const flags = args.slice(1).filter((a, i) => a !== "--bg" && a !== "--resume" && args[i] !== "--resume");
  // No login: what it starts or resumes stops before its turn, blocked, saying so where Claude Code saves its state.
  const loggedOut = fs.existsSync(path.join(dir, "logged-out"));
  const block = (sessionId: string) => {
    if (!loggedOut) return;
    const a = list.find((x) => x.sessionId === sessionId);
    Object.assign(a, { state: "blocked", status: "idle" });
    const at = path.join(jobs, a.id, "state.json");
    let saved = {};
    try {
      saved = JSON.parse(fs.readFileSync(at, "utf8"));
    } catch {}
    fs.mkdirSync(path.dirname(at), { recursive: true });
    fs.writeFileSync(at, JSON.stringify({ ...saved, sessionId, state: "blocked", tempo: "blocked", detail: "Login expired", updatedAt: new Date().toISOString() }));
  };
  // `--resume <id> --fork-session`: a new session (FAKE_CLAUDE_DIR/next.txt names it) whose transcript starts with the
  // other's, copied as Claude Code copies it (ids and times kept, its own session id on each entry), whatever the other
  // is doing. The other is left as it is.
  if (r >= 0 && args.includes("--fork-session")) {
    const from = args[r + 1];
    const next = path.join(dir, "next.txt");
    const sid = fs.existsSync(next) ? fs.readFileSync(next, "utf8").trim() : crypto.randomUUID();
    fs.rmSync(next, { force: true });
    const projects = path.join(process.env.CLAUDE_CONFIG_DIR || dir, "projects");
    for (const p of fs.existsSync(projects) ? fs.readdirSync(projects) : []) {
      const was = path.join(projects, p, `${from}.jsonl`);
      if (!fs.existsSync(was)) continue;
      const lines = fs.readFileSync(was, "utf8").split("\n").filter(Boolean).map((l) => JSON.stringify({ ...JSON.parse(l), sessionId: sid }));
      fs.writeFileSync(path.join(projects, p, `${sid}.jsonl`), lines.join("\n") + "\n");
    }
    add(sid);
    block(sid);
    save(list);
    fs.mkdirSync(path.join(jobs, sid.slice(0, 8)), { recursive: true });
    fs.writeFileSync(path.join(jobs, sid.slice(0, 8), "state.json"), JSON.stringify({ state: "working", respawnFlags: flags.filter((f) => f !== "--fork-session"), sessionId: sid, intent: args[0], cwd: process.cwd(), createdAt: new Date().toISOString() }));
    console.log(`backgrounded · ${sid.slice(0, 8)}`);
    process.exit(0);
  }
  if (r >= 0) {
    const sid = args[r + 1];
    const a = list.find((x) => x.sessionId === sid);
    // FAKE_CLAUDE_DIR/copy.txt: the next resume starts a copy whatever agentbook did (Claude Code has it open in
    // another process, say).
    const anyway = path.join(dir, "copy.txt");
    if (a?.pid || (a && flags.some((f) => f !== "--plugin-dir" && f.startsWith("--"))) || (a && fs.existsSync(anyway))) {
      fs.rmSync(anyway, { force: true });
      const copy = crypto.randomUUID();
      add(copy);
      block(copy);
      save(list);
      console.log(`note: ${a.id} is still running, so this started a copy as ${copy.slice(0, 8)}`);
      console.log(`backgrounded · ${copy.slice(0, 8)}`);
      process.exit(0);
    }
    if (a) Object.assign(a, { state: "working", status: "busy", pid: 4244 });
    else add(sid);
    block(sid);
    save(list);
    console.log(`backgrounded · ${sid.slice(0, 8)}`);
    process.exit(0);
  }
  const next = path.join(dir, "next.txt");
  const sid = fs.existsSync(next) ? fs.readFileSync(next, "utf8").trim() : crypto.randomUUID();
  fs.rmSync(next, { force: true });
  add(sid);
  save(list);
  fs.mkdirSync(path.join(jobs, sid.slice(0, 8)), { recursive: true });
  fs.writeFileSync(path.join(jobs, sid.slice(0, 8), "state.json"), JSON.stringify({ state: "working", respawnFlags: flags, sessionId: sid, intent: args[0], cwd: process.cwd(), createdAt: new Date().toISOString() }));
  // FAKE_CLAUDE_DIR/slow.txt: how long it takes to say it started (ms), once (a start agentbook-cli stops during).
  const slow = path.join(dir, "slow.txt");
  if (fs.existsSync(slow)) {
    const ms = Number(fs.readFileSync(slow, "utf8"));
    fs.rmSync(slow, { force: true });
    await new Promise((r) => setTimeout(r, ms));
  }
  console.log(`backgrounded · ${sid.slice(0, 8)}\n\n  claude agents             list sessions\n  claude attach ${sid.slice(0, 8)}      open in this terminal`);
  process.exit(0);
}
if (args[0] !== "attach") {
  console.error(`fake claude: unsupported ${args.join(" ")}`);
  process.exit(2);
}
