// Claude Code's hooks, on loopback: a session saying hello (SessionStart, and again at a prompt), its status as each
// turn starts and ends, its end, and the permission prompts and questions of a background session, which nobody is
// at a terminal to answer.

import { canonicalAgentDirectory, defaultAgentDirectory } from "../../agent-context.ts";
import { bird } from "../../../lib/common.ts";
import { desktopStarts } from "../../desktop.ts";
import { describeTool } from "../../transcript.ts";
import { foldedInto } from "../../../shared/store.ts";
import type { OpOf } from "../../../shared/ops.ts";
import { mine } from "./host.ts";
import type { ClaudeHost, Route } from "./host.ts";
import type { Pickup } from "./pickup.ts";
import type { Supervisor } from "./supervisor.ts";

// Visual mode, for every agent: what its sessions are told when they start (contextFor), and reminded of as each
// turn starts.
export const VISUAL_REMINDER = "agentbook, Visual mode: the person reads this turn's reply at a glance, on a phone. The answer in the first sentence, then only what changes their next move, in whole sentences, nothing twice, under 120 words unless they asked for detail. Right before it: ab_verdict (the one line, which the reply doesn't repeat) and ab_suggest (what they'd say next). Other shapes only when text can't do it: ab_checks for a failed check, ab_todo with answers for a decision of theirs, ab_compare for pictures or numbers, ab_cards for alternatives, ab_draft for something to send.";

export function createHooks(h: ClaudeHost, cc: Pick<Supervisor, "waking" | "asleep" | "listSoon"> & Pick<Pickup, "cutOff" | "dropCut" | "loginBack" | "pickable">, route: Route) {
  const { state, commit, log, claude, started, uplink, postOf, readBody, ok, fail, str, slug, heard, localKeyOk, updateNote, startedElsewhere, launchInFlight, keepOff, keptOff, KEPT_OFF, OFF, offHello, loginLost, toldLoginLost, settlePermissions } = h;
  const { waking, asleep, listSoon, cutOff, dropCut, loginBack, pickable } = cc;

  // --- sessions: registration and status, from hooks and the MCP server ---
  route("POST", "/api/hello", async (req, res) => {
    const b = await readBody(req);
    if (!b.proc) return fail(res, 400, "proc is required");
    // Not logged in: nothing of this session is kept, and it's told so.
    if (!started()) return ok(res, { post: null, login: true });
    heard(String(b.proc), localKeyOk(req));
    // A thread starting (`starting`, from its SessionStart hook) tries once more after its server refused this machine's
    // login, waited for a moment, so what it hears as it starts is how that went.
    if (b.starting && uplink()?.status().signed_out) await Promise.race([uplink().tryAgain(), new Promise((r) => setTimeout(r, 2000).unref())]);
    const said = (r) => ok(res, { ...r, ...updateNote({ session: true }) });
    let directory: string | null = null;
    try { directory = canonicalAgentDirectory(b.config_dir || defaultAgentDirectory("claude-code")); } catch {}
    const configured = Object.values(state.agents).find(a => a.kind === "claude-code" && a.config_dir && (a.id === b.agent_id || a.config_dir === directory));
    const agentName = configured?.name || str(b.agent || "Claude", 80);
    // Claude Code starts a background session in a worker it made earlier, with the variables of the launch that
    // started its daemon: a launch another thread took already. Its name came with it, so every thread it starts
    // would have that one; it gets a bird of its own instead.
    const told = b.launch && state.launches[b.launch];
    const stale = told?.post && told.post !== (b.session_id || b.proc);
    const label = stale ? bird(String(b.proc)) : b.label;
    // A session in a terminal that has only just started (`claude`, or /clear: `fresh`, from its SessionStart hook)
    // gets its thread at its first prompt, when its hooks call again and find it isn't registered: until then
    // nothing has happened in it, and opening Claude Code and quitting would leave a "New thread" waiting for a
    // prompt. One that already has a thread (a copy of one), that a launch waits for, or that runs in the background
    // registers now. The conversation it moved on from (/clear) is over either way.
    if (b.session_id && !claude.info(b.session_id)) listSoon();
    const own = (b.session_id && foldedInto(state, b.session_id)) || b.session_id || b.proc;
    const awaited = (told && !told.post && !told.error) || Object.values(state.launches).some((l) => l.session && !l.post && !l.error && String(own).startsWith(l.session));
    if (b.fresh && !state.sessions[own] && !awaited && !claude.background(b.session_id)) {
      const was = state.procs[b.proc];
      if (was && was !== own && state.sessions[was] && state.sessions[was].state !== "done") commit({ t: "session.gone", post: was, reason: "Cleared" });
      return said({ post: null, deferred: true });
    }
    const op: OpOf<"session.hello"> = {
      t: "session.hello",
      proc: str(b.proc, 120),
      agent: configured?.id || slug(agentName),
      agent_name: agentName,
      kind: str(b.kind || "claude-code", 40),
      label: str(label || "session", 40),
      // AGENTBOOK_LABEL: kept as it is (see freeName in store.ts). A session from before `named` goes by its name.
      named: !stale && (b.named ?? (!!label && label !== bird(String(b.proc)))),
      session_id: b.session_id ? str(b.session_id, 80) : undefined,
      transcript: typeof b.transcript === "string" ? b.transcript : undefined,
      cwd: b.cwd,
      root: b.root,
      repo: b.repo,
      branch: b.branch,
      pid: b.pid,
      host: b.host,
      channel: !!b.channel,
      app: b.app === "desktop" || b.app === "vscode" ? b.app : undefined,
      launch: b.launch ? str(b.launch, 40) : undefined,
    };
    // A thread its person stopped following, or a session started with AGENTBOOK_OFF=1: nothing of it is kept.
    if (offHello(op)) {
      keepOff(op);
      return said({ post: null, private: true, said: OFF });
    }
    // Private terminals: a session agentbook didn't start gets no thread. One agentbook may have just started is
    // waited for a moment, and else asked again at its next hook.
    for (let i = 0; i < 25 && startedElsewhere(op) && launchInFlight(); i++) await new Promise((r) => setTimeout(r, 100));
    if (startedElsewhere(op)) {
      if (launchInFlight()) return said({ post: null, deferred: true });
      keepOff(op);
      return said({ post: null, private: true, said: KEPT_OFF });
    }
    keptOff.delete(op.proc);
    commit(op);
    const key = state.procs[b.proc];
    said({ post: key, label: state.sessions[key].label });
    // A Claude Desktop session may have been started by another: its thread says which.
    if (op.app === "desktop" && !state.sessions[key].started_from) linkDesktop(key).catch((e) => log(`desktop: ${e.message}`));
  });

  // Claude Desktop sessions another one started (desktop.ts): each one's thread says the thread it was started from,
  // all of them as agentbook-cli starts (those from before it ran), and each new one as it says hello. `only`: just
  // that thread.
  const threadOfSession = (sid) => (sid && (foldedInto(state, sid) || (state.sessions[sid] ? sid : Object.values(state.sessions).find((s) => s.session_id === sid)?.id))) || null;
  async function linkDesktop(only = null) {
    let starts;
    try {
      starts = await desktopStarts();
    } catch (e) {
      return log(`desktop: couldn't read its sessions: ${e.message}`);
    }
    for (const [sid, { from }] of starts) {
      const post = threadOfSession(sid);
      if (!post || (only && post !== only) || state.sessions[post].started_from) continue;
      const parent = from.map(threadOfSession).find((p) => p && p !== post);
      if (parent) commit({ t: "session.from", post, started_from: parent });
    }
  }

  route("POST", "/api/procs/:proc/status", async (req, res, { params }) => {
    const b = await readBody(req);
    const post = postOf(res, params.proc);
    if (!post) return;
    const states = ["working", "idle", "waiting"];
    const turn = b.turn === "start" || b.turn === "end" ? b.turn : undefined;
    const transcript = typeof b.transcript === "string" && b.transcript !== state.sessions[post].transcript ? b.transcript : undefined;
    const failed = turn === "end" && b.failed ? str(b.failed, 40) : undefined;
    const ended = turn === "end" && state.sessions[post].busy; // its turn, not a reminder that it's idle
    // Where it's typed (appOf), said at each prompt for a thread that registered before agentbook kept it.
    const app = turn === "start" && (b.app === "desktop" || b.app === "vscode") && b.app !== state.sessions[post].app ? b.app : undefined;
    commit({ t: "session.status", post, state: states.includes(b.state) ? b.state : undefined, text: str(b.text, 200) || undefined, turn, transcript, failed, app });
    // Whether it runs in the background decides whether agentbook picks it up, so a session Claude Code's list
    // doesn't have yet is looked up first.
    if (failed && !claude.info(state.sessions[post].session_id)) await claude.refresh().catch(() => {});
    if (failed && pickable(state.sessions[post])) cutOff(post);
    else if (ended) dropCut(post);
    // A Claude Code session got a reply, so Claude Code is signed in.
    if (ended && b.replied && !failed && mine(state.sessions[post])) loginBack(Date.now(), state.sessions[post].agent);
    // A finished or newly started turn means any permission prompt was settled in the terminal, and Claude's
    // questions a hook was waiting on with it.
    if (b.settle_permissions) settlePermissions(post, "terminal");
    // A turn starting: its hook hands the agent Visual mode's reminder.
    const sv = state.sessions[post];
    const lost = turn === "start" && !toldLoginLost.has(post) ? loginLost() : null;
    if (lost) toldLoginLost.add(post);
    ok(res, { ...(turn === "start" && sv.agent && mine(sv) ? { remind: VISUAL_REMINDER } : {}), ...(lost ? { login_lost: lost } : {}) });
  });

  route("POST", "/api/procs/:proc/gone", async (req, res, { params }) => {
    const b = await readBody(req);
    const post = state.procs[params.proc];
    // A session agentbook is waking ends only to start again under the same id. A background session whose
    // process ends goes to sleep: its conversation is kept, and writing to its post wakes it.
    if (post && !waking.has(post)) {
      if (claude.background(state.sessions[post].session_id)) asleep(post);
      else commit({ t: "session.gone", post, reason: str(b.reason, 120) || "Ended" });
    }
    ok(res);
  });

  // A background session needs permission for a tool call (its PermissionRequest hook). Nobody's at a
  // terminal to see Claude Code's prompt, so it becomes Allow/Deny on the post and the hook waits for it.
  // Sessions in a terminal get their usual prompt instead.
  // "mcp__plugin_agentbook_agentbook__ab_post" reads as "agentbook ab_post".
  function toolLabel(name) {
    if (!name.startsWith("mcp__")) return name;
    const [, server = "", tool = ""] = name.split("__");
    return `${server.replace(/^plugin_[^_]+_/, "").replace(/^claude_ai_/, "")} ${tool}`;
  }
  function previewOf(tool, input: Record<string, unknown> = {}) {
    if (tool === "Bash") return str(input.command, 2000);
    if (input.file_path) return str(input.file_path, 500);
    if (input.url) return str(input.url, 500);
    return str(JSON.stringify(input, null, 2), 2000);
  }
  route("POST", "/api/procs/:proc/permission", async (req, res, { params }) => {
    const b = await readBody(req);
    const post = postOf(res, params.proc);
    if (!post) return;
    const s = state.sessions[post];
    if (!claude.info(s.session_id)) await claude.refresh();
    if (!claude.background(s.session_id)) return ok(res, { wait: false });
    // Claude asking you something (AskUserQuestion): each question is a poll, with its options and room for an
    // answer of your own. The hook waits for them all and hands Claude the answers.
    if (b.tool_name === "AskUserQuestion") {
      const asked = (Array.isArray(b.tool_input?.questions) ? b.tool_input.questions : []).slice(0, 4);
      if (!asked.length) return ok(res, { wait: false });
      const ids = asked.map((one, i) => {
        const op = commit({ t: "question.ask", post, kind: one.multiSelect ? "multi" : "choice", title: str(one.question, 500), detail: str(one.header, 40), options: (one.options || []).slice(0, 6).map((o) => ({ label: str(o.label, 120), detail: str(o.description, 300) || null })), key: `ask:${str(b.tool_use_id, 80) || state.seq}:${i}`, hook: true, other: true });
        return op.qid;
      });
      return ok(res, { wait: true, ask: true, ids });
    }
    const tool = str(b.tool_name || "a tool", 120);
    const name = toolLabel(tool);
    const op = commit({ t: "question.ask", post, kind: "permission", title: `Allow ${name}?`, detail: describeTool(tool, b.tool_input || {}, s.cwd), preview: previewOf(tool, b.tool_input || {}), request_id: `h${state.seq + 1}`, tool_name: name });
    ok(res, { wait: true, id: op.qid });
  });

  // The hook stopped waiting (after a day): its questions close, and the session waits in Claude Code's own
  // prompt, where only a terminal (claude attach) reaches it.
  route("POST", "/api/procs/:proc/permission/expire", async (req, res, { params }) => {
    const b = await readBody(req);
    const post = postOf(res, params.proc);
    if (!post) return;
    for (const qid of Array.isArray(b.ids) ? b.ids : []) if (state.questions.some((q) => q.id === qid && q.post === post && !q.answered)) commit({ t: "question.answer", qid, value: null, by: "expired" });
    commit({ t: "session.status", post, state: "waiting", text: "Waiting in Claude Code: open it in a terminal to answer" });
    ok(res);
  });

  return { linkDesktop };
}
