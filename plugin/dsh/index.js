// agentbook's plugin for DeepSeek Harness (dsh): every session in the dsh process it's added to (dsh's web app, its
// desktop app, a terminal) shows on agentbook as a thread, live, and you answer it from there too.
// agentbook runs the sessions it starts itself through dsh's ACP server
// (plugin/cli/runtimes/dsh/dsh.ts); this is for the rest.
//
// dsh is built from Cordis plugins, and this is one: in the same process as the rest, it hears what dsh's own
// ACP bridge hears, for every session there.
// - It dials agentbook-cli on this machine (ws://127.0.0.1:4320/api/dsh/ws, or the `url` it's given, else
//   AGENTBOOK_URL) and says hello: its version, which profile it's in, the process. With the key in agentbook-cli's
//   folder, the address is signed with it (never showing it), and agentbook-cli's first message proves it holds it
//   too: until then the plugin sends nothing and takes nothing, so what else holds that port can't steer dsh.
// - Each session, once a connection: { t: "session", id, cwd, parent, … }, with the session's header. Then each record
//   dsh writes to the session's log, as it's written ({ t: "event", id, e }: a turn begun or ended, what was said,
//   a tool called and how it went, its title, its model), whether it's running ({ t: "status" }), its errors
//   ({ t: "error" }), and its subagents starting and ending ({ t: "subagent" }). agentbook reads the logs for what
//   came before, and after a connection was down.
// - A string over 64 KB in one (a tool's output) goes cut: agentbook reads the whole one from the log.
// - When agentbook isn't there, it does nothing: it tries again a couple of times after a connection ends, then at
//   a session's next event, at most every 10 seconds. It never runs a timer that looks.
//
// What agentbook sends back, for the sessions it shows as threads:
// - { t: "equip", id, url }: the session is a thread. Its agent gets agentbook's tools (ab_post, ab_ask…), an MCP
//   server at `url`, as dsh's ACP server gives a session the servers its client names. A session dsh opens again (a
//   new agent) is equipped again.
// - { t: "message", id, text }: what you wrote on the thread. In dsh's web and desktop apps it goes as theirs does
//   (their session controller, which opens the session first when it isn't); elsewhere to the session's live agent.
//   While a turn runs it reaches the model at its next step (steer), else it starts one (follow-up).
// - { t: "stop", id }: Stop, as their Stop button does (the turn ends, what's queued stays).
// - { t: "create", cwd }: a new session, for a thread you start on agentbook, in dsh's web or desktop app (their
//   session controller, as their New Session does, in the folder's workspace when it has one), so it shows there too.
//   Then { t: "model", id, model, effort } when you picked one ("provider/model", as dsh's own picker sets it), and its
//   first message, with agentbook's instructions for it as `context`: model-facing context dsh doesn't show as yours.
// - { t: "mode", id, mode }: how much a thread you start may do without asking (agentbook's Ask, Auto, Plan or Full
//   access), as dsh's permission preset (read-only, workspace-write, danger-full-access) and, for Plan, its plan
//   mode.
// - { t: "adopt", id }: a session agentbook runs over dsh's ACP server: what it asks with ask_user_question (a plan's
//   review too) is asked on its thread. Its approvals come over ACP.
// - Each has a `rid`, and the plugin answers { t: "done", rid, value?, error? }.
// - It says what it can do in its hello (`can`), and the models dsh's app has keys for ({ t: "models" }), for
//   agentbook's pickers.
// - dsh asking before a tool runs (approval/request) and its ask_user_question (user-questions/request) go to
//   agentbook as { t: "ask" } as well as to dsh's own app, and the first answer wins: one from agentbook
//   ({ t: "answer" }) closes dsh's own prompt, one from dsh's app is { t: "settled" } to agentbook. A question whose
//   wait in dsh ran out (it's "continued") can still be answered from agentbook.
//
// agentbook loads it into its own ACP server too (`own` in its config, which its hello says back): ACP has no setting
// for a session's mode, and no way to ask its questions. There it says nothing of its sessions, which ACP does.
//
// Add it to a profile with `dsh plugin --profile web add file:<this folder>` (and desktop), then restart dsh. No
// packages: it needs Node's WebSocket (Node 22 and up, which dsh runs on), and loads dsh's own MCP client the way
// dsh loads its plugins.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const VERSION = JSON.parse(fs.readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;
const CUT = 64 * 1024;
const RETRY_MS = [2000, 10000]; // after a connection ends, it tries again this soon, then this
const QUIET_MS = 10000; // and then at a session's event, at most this often
const PROOF_MS = 5000; // how long agentbook-cli has to prove it holds the key
const MODELS_MS = 10000;


// agentbook's folder when AGENTBOOK_HOME doesn't say: the default account's, else ~/.agentbook (AGENTBOOK_ROOT), as
// plugin/shared/home.ts picks it.
function defaultHome() {
  const root = process.env.AGENTBOOK_ROOT || path.join(os.homedir(), ".agentbook");
  try {
    const d = JSON.parse(fs.readFileSync(path.join(root, "accounts", "accounts.json"), "utf8"))?.default;
    if (typeof d === "string" && /^[\w-]+$/.test(d) && fs.existsSync(path.join(root, "accounts", d, "machine.json"))) return path.join(root, "accounts", d);
    // Else the root itself, for the account its data from before accounts became.
  } catch {}
  return root;
}

// What says this is its person's, to an agentbook-cli on this machine: the key in its folder, for that address only.
// That's the folder's own agentbook-cli (its port, AGENTBOOK_PORT or 4320), or any on this machine when AGENTBOOK_HOME
// names the folder: an agentbook-cli at another address, with a folder of its own, can't prove it holds this one's key.
function localKey(base) {
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(base)) return "";
  let port;
  try {
    port = Number(new URL(base).port || 80);
  } catch {
    return "";
  }
  if (!process.env.AGENTBOOK_HOME && port !== Number(process.env.AGENTBOOK_PORT || 4320)) return "";
  try {
    return fs.readFileSync(path.join(process.env.AGENTBOOK_HOME || defaultHome(), "cli", "local.key"), "utf8").trim();
  } catch {
    return "";
  }
}
// The address signed with it, and agentbook-cli's proof checked: plugin/shared/local-auth.ts, whose copy this is, as
// dsh loads this folder alone.
const mac = (key, text) => crypto.createHmac("sha256", key).update(text).digest("base64url");
function signed(key, target) {
  const at = Date.now();
  const nonce = crypto.randomBytes(16).toString("base64url");
  const body = crypto.createHash("sha256").update("").digest("hex");
  return { auth: `1.${at}.${nonce}.${mac(key, ["agentbook request", at, nonce, "GET", target, body].join("\n"))}`, nonce };
}
function proved(key, nonce, got) {
  const want = Buffer.from(mac(key, `agentbook answer\n${nonce}`));
  const had = Buffer.from(String(got || ""));
  return had.length === want.length && crypto.timingSafeEqual(had, want);
}

// Which of dsh's profiles this process runs: the one it's installed in (…/profiles/<name>/node_modules/…), what
// dsh was started with (`dsh web`, `dsh --profile desktop`), else "dsh".
export function profileOf(argv = process.argv, url = import.meta.url) {
  const installed = /\/profiles\/([^/]+)\/node_modules\//.exec(decodeURIComponent(String(url)))?.[1];
  if (installed) return installed;
  const at = argv.indexOf("--profile");
  if (at >= 0 && argv[at + 1]) return argv[at + 1];
  const eq = argv.find((a) => a.startsWith("--profile="));
  if (eq) return eq.slice(10);
  const cmd = argv.slice(2).find((a) => !a.startsWith("-"));
  return cmd && /^[a-z][\w-]{0,30}$/i.test(cmd) ? cmd : "dsh";
}

// A record as it's sent: as it is, unless a string in it is over CUT.
function cut(value, depth = 0) {
  if (typeof value === "string") return value.length > CUT ? `${value.slice(0, CUT)}\n… (cut: ${value.length - CUT} more characters in dsh's log)` : value;
  if (!value || typeof value !== "object" || depth > 12) return value;
  if (Array.isArray(value)) return value.map((v) => cut(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = cut(v, depth + 1);
  return out;
}
const sized = (e) => {
  try {
    const text = JSON.stringify(e);
    return text.length > CUT ? cut(JSON.parse(text)) : e;
  } catch {
    return null;
  }
};
const messageOf = (error) => String((error && (error.message || error.reason)) || error || "Failed").slice(0, 2000);
const str = (v, max = 2000) => (v == null ? null : String(v).slice(0, max));
// dsh says some things in more than one language ({ en, zh }).
const said = (v) => (typeof v === "string" ? v : v && typeof v === "object" ? v.en || Object.values(v).find((x) => typeof x === "string") || null : null);
function frozen(o) {
  if (o && typeof o === "object") {
    for (const v of Object.values(o)) frozen(v);
    Object.freeze(o);
  }
  return o;
}

export const name = "agentbook";

export function apply(ctx, config = {}) {
  const base = String(config?.url || process.env.AGENTBOOK_URL || `http://127.0.0.1:${process.env.AGENTBOOK_PORT || 4320}`).replace(/\/$/, "");
  const url = `${base.replace(/^http/, "ws")}/api/dsh/ws`;
  const profile = config?.profile || profileOf();
  const log = (msg) => ctx.logger?.("agentbook")?.debug?.(msg);
  // session id -> { header, status, told: the connection it was last told to }
  const sessions = new Map();
  const threads = new Set(); // the sessions agentbook shows as threads (it equipped them): only theirs ask there
  const adopted = new Set(); // sessions agentbook runs over ACP: their questions ask there
  // In agentbook's own ACP server, which says what its sessions do itself.
  const own = config?.own ? String(config.own) : null;
  const agents = new Map(); // session id -> its live agent, as dsh's events carry it
  const asks = new Map(); // ask key -> { msg, answer(value), late, agent, call }
  const equipped = new WeakSet(); // agents that have agentbook's tools
  let ws = null;
  let open = false;
  let lastTry = 0;
  let retries = 0;
  let stopped = false;
  let modelsRevision = 0;
  let modelsRetry = null;
  let keptModels = null;

  // dsh's services, once it has them: its agents, its questions, and in its web and desktop apps the session
  // controller their pages use. A plugin only gets one it asks for (ctx.inject).
  const svc = { agents: null, controller: null, questions: null, workspaces: null, presets: null, plan: null, sessions: null };
  const need = (names, key) => {
    if (typeof ctx.inject !== "function") return;
    try {
      ctx.inject(names, (c) => {
        svc[key] = c;
        if ((key === "controller" || key === "presets") && open) hello(); // it can start sessions, or set modes, now
        c.effect?.(() => () => {
          if (svc[key] === c) svc[key] = null;
        });
      });
    } catch (e) {
      log(`agentbook: ${names.join(", ")}: ${e.message}`);
    }
  };
  need(["agents"], "agents");
  need(["sessionController"], "controller");
  need(["userQuestions"], "questions");
  need(["workspaceRegistry"], "workspaces");
  need(["permissionPresets"], "presets");
  need(["planMode"], "plan");
  need(["sessions"], "sessions");
  const liveAgent = (id) => {
    try {
      const a = svc.agents?.agents?.get(id);
      if (a) return a;
    } catch {}
    return agents.get(id) || null;
  };
  const controller = () => {
    try {
      return svc.controller?.sessionController?.commands || null;
    } catch {
      return null;
    }
  };

  const send = (m) => {
    if (!open) return false;
    try {
      ws.send(JSON.stringify(m));
      return true;
    } catch (e) {
      log(`agentbook: couldn't send: ${e.message}`);
      return false;
    }
  };
  // Who it is, and what it can do: start sessions and pick their models where dsh has an app (its session controller),
  // and set a session's mode where dsh has permission presets.
  function hello() {
    const can = [...(controller() ? ["create", "model"] : []), "context", "adopt", ...(svc.presets ? ["mode"] : [])];
    send({ t: "hello", plugin: VERSION, profile, pid: process.pid, home: process.env.DSH_HOME || null, node: process.version, can, ...(own ? { own } : {}) });
    if (keptModels && keptModels.from === svc.controller) send(keptModels.message);
    tellModels();
  }
  // A session agentbook hasn't heard of on this connection: what its header says.
  function tell(id) {
    const s = sessions.get(id);
    if (!s || !open || own || s.told === ws) return;
    s.told = ws;
    const h = s.header || {};
    send({ t: "session", id, cwd: h.cwd || null, parent: h.parentSession || null, origin: h.origin || null, created: h.createdAt || null, preset: h.agentPreset || null, status: s.status || null });
  }
  function note(id, header, status) {
    if (!id) return null;
    let s = sessions.get(id);
    if (!s) sessions.set(id, (s = { header: null, status: null, told: null }));
    if (header) s.header = header;
    if (status) s.status = status;
    if (!ws && !stopped && Date.now() - lastTry > QUIET_MS) connect();
    tell(id);
    return s;
  }
  const seen = (agent) => {
    if (agent?.id) agents.set(agent.id, agent);
    return agent;
  };

  function connect() {
    if (stopped || ws || typeof WebSocket !== "function") return;
    lastTry = Date.now();
    let sock;
    let proof = null; // { key, nonce } until agentbook-cli has proved it holds the key
    let wait = null;
    try {
      const key = localKey(base);
      const sig = key ? signed(key, new URL(url).pathname) : null;
      if (sig) proof = { key, nonce: sig.nonce };
      const query = new URLSearchParams({ ...(sig ? { auth: sig.auth } : {}), ...(process.env.AGENTBOOK_AGENT_ID ? { agent: process.env.AGENTBOOK_AGENT_ID } : {}), ...(process.env.DSH_HOME ? { home: process.env.DSH_HOME } : {}) });
      sock = new WebSocket(query.size ? `${url}?${query}` : url);
    } catch (e) {
      return log(`agentbook: ${e.message}`);
    }
    ws = sock;
    const ready = () => {
      open = true;
      retries = 0;
      hello();
      for (const id of sessions.keys()) tell(id);
      // What's still waiting on an answer, asked again (agentbook forgets its questions when it restarts).
      for (const a of asks.values()) send(a.msg);
    };
    sock.onopen = () => {
      if (ws !== sock) return;
      if (!proof) return ready();
      wait = setTimeout(() => {
        log("agentbook: what answers on agentbook-cli's port didn't prove it's agentbook-cli, so it isn't used (one older than this plugin sends no proof: agentbook-cli down, then agentbook-cli up)");
        sock.close();
      }, PROOF_MS);
      wait.unref?.();
    };
    sock.onmessage = (ev) => {
      if (ws !== sock) return;
      let m;
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        m = null;
      }
      if (proof) {
        clearTimeout(wait);
        const good = m?.t === "proof" && proved(proof.key, proof.nonce, m.proof);
        proof = null;
        if (!good) {
          log("agentbook: something other than agentbook-cli answers on its port, so it isn't used");
          return sock.close();
        }
        return ready();
      }
      if (m) heard(m).catch((e) => log(`agentbook: ${e.message}`));
    };
    sock.onerror = () => {};
    sock.onclose = () => {
      clearTimeout(wait);
      if (ws !== sock) return;
      ws = null;
      open = false;
      clearTimeout(modelsRetry);
      // What only agentbook could answer (dsh has no prompt of its own for it) ends as it would without agentbook.
      for (const a of [...asks.values()]) if (a.alone) a.drop();
      if (!stopped && retries < RETRY_MS.length) setTimeout(connect, RETRY_MS[retries++]).unref?.();
    };
  }

  /* ---------- what agentbook sends ---------- */

  async function heard(m) {
    switch (m?.t) {
      case "message":
        return done(m.rid, () => prompt(String(m.id || ""), String(m.text || ""), String(m.rid || crypto.randomUUID()), str(m.context, 64000)));
      case "create":
        return done(m.rid, () => create(str(m.cwd, 4000)));
      case "model":
        return done(m.rid, () => pick(String(m.id || ""), str(m.model, 400), str(m.effort, 100)));
      case "stop":
        return done(m.rid, () => cancel(String(m.id || "")));
      case "equip":
        return done(m.rid, () => equip(String(m.id || ""), str(m.url, 4000)));
      case "mode":
        return done(m.rid, () => setMode(String(m.id || ""), String(m.mode || "")));
      case "adopt":
        return done(m.rid, () => void (m.id && adopted.add(String(m.id))));
      case "answer":
        return answered(String(m.ask || ""), m.value);
    }
  }
  async function done(rid, fn) {
    try {
      const value = await fn();
      send({ t: "done", rid, ...(value === undefined ? {} : { value }) });
    } catch (e) {
      send({ t: "done", rid, error: messageOf(e) });
    }
  }

  // A message, as dsh's own apps send one: it says it's yours (source "user"), with agentbook's id for it (so it isn't
  // shown twice, and dsh takes it once). `context` (a thread's first message: what agentbook tells the agents it
  // starts) goes ahead of it as context for the model, which dsh doesn't show as yours.
  async function prompt(id, text, rid, context) {
    if (!id || !text.trim()) throw new Error("Nothing to send.");
    const agent = liveAgent(id);
    if (context && typeof agent?.inject === "function") agent.inject(frozen({ content: [{ type: "text", text: context }], source: { kind: "agentbook" }, role: "user", id: crypto.randomUUID() }));
    else if (context) text = `${text}\n\n${context}`;
    const mode = agent?.status === "running" ? "steer" : "queue";
    const commands = controller();
    if (commands?.prompt) return void (await commands.prompt({ sessionId: id, requestId: rid, mode, content: [{ type: "text", text }] }, { kind: "user", rpcId: rid }));
    if (!agent) throw new Error("dsh doesn't have this session open here.");
    const message = frozen({ content: [{ type: "text", text }], source: { kind: "user", rpcId: rid }, role: "user", id: crypto.randomUUID() });
    if (mode === "steer") agent.steer(message);
    else agent.followup(message);
  }

  function cancel(id) {
    const commands = controller();
    if (commands?.cancel) return void commands.cancel({ sessionId: id });
    const agent = liveAgent(id);
    if (!agent) throw new Error("It isn't running.");
    agent.cancel({ kind: "user" }, { keepInbox: true });
  }

  // A new session in dsh's app, as its New Session makes one: in the workspace at that folder when there is one (its
  // sidebar lists it there), else in the folder (under Ungrouped).
  async function create(cwd) {
    const commands = controller();
    if (typeof commands?.create !== "function") throw new Error("This dsh has no app to start a session in.");
    if (!cwd) throw new Error("No folder to start it in.");
    let workspace = null;
    try {
      workspace = await svc.workspaces?.workspaceRegistry?.resolveByPath?.(cwd);
    } catch {}
    const same = workspace?.id && workspace.path && path.resolve(String(workspace.path)) === path.resolve(cwd);
    const r = await commands.create(same ? { workspaceId: workspace.id } : { cwd });
    if (!r?.sessionId) throw new Error("dsh didn't say which session it made.");
    return { id: String(r.sessionId) };
  }

  // A model for a session ("provider/model", and how hard it thinks), as dsh's own picker sets one: it's checked
  // against the models dsh has keys for, and, as there, it's the app's default from then on.
  async function pick(id, model, effort) {
    const at = String(model || "").indexOf("/");
    if (!id || at <= 0) throw new Error("dsh's models are named provider/model.");
    const commands = controller();
    if (typeof commands?.selectModel !== "function") throw new Error("This dsh has no app to pick a model in.");
    const r = await commands.selectModel({ sessionId: id, provider: model.slice(0, at), model: model.slice(at + 1), ...(effort ? { reasoningEffort: effort } : {}) });
    tellModels();
    return r?.selected ? { model: `${r.selected.provider}/${r.selected.model}`, effort: r.selected.reasoningEffort || null } : undefined;
  }

  // A thread's mode, as dsh's permission preset: Ask is read-only (each change asks), Auto workspace-write (dsh's
  // default: changes in its folder go ahead, wider ones ask), Full access danger-full-access (it never asks). Plan is
  // dsh's plan mode, on workspace-write: once you approve its plan, it carries on as in Auto.
  const PRESETS = { ask: "read-only", auto: "workspace-write", plan: "workspace-write", full: "danger-full-access" };
  function setMode(id, mode) {
    const preset = PRESETS[mode];
    if (!id || !preset) throw new Error(`agentbook has no mode "${mode}" for dsh.`);
    const presets = svc.presets?.permissionPresets;
    if (!presets) throw new Error("This dsh has no permission presets.");
    if (!presets.names.includes(preset)) throw new Error(`This dsh has no ${preset} preset (it has ${presets.names.join(", ")}).`);
    const agent = liveAgent(id);
    let session = agent?.session || null;
    try {
      session ||= svc.sessions?.sessions?.get?.(id) || null;
    } catch {}
    if (!session) throw new Error("dsh doesn't have this session open here.");
    if (mode === "plan" && (!svc.plan?.planMode || !agent)) throw new Error("This dsh has no plan mode.");
    presets.set(session, preset);
    if (mode === "plan") svc.plan.planMode.set(agent, true);
    return { preset: presets.current(session), plan: mode === "plan" };
  }

  // The models dsh's app can run (the providers it has keys for), and its default, as agentbook's pickers list them.
  // Whether a list is still this app's goes by the controller dsh injected (svc.controller), never its
  // sessionController: dsh 0.2.1 hands out a new one each time it's read, so that one never matched and every list
  // was dropped.
  async function tellModels() {
    const from = svc.controller;
    const source = from?.sessionController;
    if (!open || !source?.modelCatalog) return;
    clearTimeout(modelsRetry);
    const revision = ++modelsRevision;
    const socket = ws;
    const current = () => !stopped && open && ws === socket && revision === modelsRevision && from === svc.controller;
    let timer;
    try {
      // A provider can hang inside dsh's catalog. Release discovery so it can retry without clearing the picker.
      const deadline = new Promise((_, reject) => timer = setTimeout(() => reject(new Error("model catalog timed out")), MODELS_MS));
      timer.unref?.();
      const catalog = await Promise.race([source.modelCatalog(), deadline]);
      if (!current()) return;
      if (!Array.isArray(catalog?.groups)) throw new Error("model catalog is not ready");
      const routable = new Set(catalog.routableProviders || catalog.groups.map((g) => g.id));
      const list = [];
      for (const g of catalog.groups)
        if (routable.has(g.id))
          for (const m of g.models || []) list.push({ id: `${g.id}/${m.id}`, name: str(m.name || m.id, 200), efforts: (m.reasoning?.efforts || []).map((e) => str(e.id, 100)).filter(Boolean), effort: str(m.reasoning?.defaultEffort, 100) });
      const d = catalog.default;
      const message = { t: "models", list: list.slice(0, 200), default: d?.provider && d?.model ? `${d.provider}/${d.model}` : null, effort: str(d?.reasoningEffort, 100) };
      keptModels = { from, message };
      send(message);
    } catch (e) {
      if (!current()) return;
      log(`agentbook: dsh's models: ${e.message}`);
      modelsRetry = setTimeout(tellModels, QUIET_MS);
      modelsRetry.unref?.();
    } finally {
      clearTimeout(timer);
    }
  }

  // agentbook's tools on a thread's agent: dsh's MCP client, mounted on it as its ACP server mounts the ones a
  // client names. They're there from its next step.
  let mcpClient = null;
  const loadMcp = () =>
    (mcpClient ||= (async () => {
      const loader = ctx.loader?.internal;
      if (typeof loader?.import !== "function") throw new Error("This dsh doesn't say how to load its MCP client.");
      const mod = await loader.import("@deepseek-ai/dsh-mcp-client", ctx.baseUrl, {});
      return typeof mod?.apply === "function" ? mod : mod?.default;
    })().catch((e) => {
      mcpClient = null;
      throw e;
    }));
  async function equip(id, mcpUrl) {
    if (!id) return;
    threads.add(id);
    const agent = liveAgent(id);
    if (!mcpUrl || !agent?.ctx || equipped.has(agent)) return;
    const McpClient = await loadMcp();
    if (equipped.has(agent)) return;
    equipped.add(agent);
    try {
      await agent.ctx.plugin(McpClient, { transport: "streamable-http", serverName: "agentbook", url: mcpUrl });
    } catch (e) {
      equipped.delete(agent);
      throw e;
    }
  }

  /* ---------- what dsh asks you ---------- */

  // A thread's approval or question goes to agentbook too, and the first answer wins. dsh's own app (next(): its
  // prompt, in each page that has the session open) closes its prompt once the request's signal aborts, so the
  // plugin hands it a signal of its own first, which aborts when agentbook answers. Without agentbook connected,
  // or for a session that isn't a thread, it's dsh's own alone.
  ctx.on("approval/request", (request, next) => ask("approval", request, next), { prepend: true });
  ctx.on("user-questions/request", (request, next) => ask("questions", request, next), { prepend: true });

  function ask(kind, request, next) {
    const agent = seen(request?.agent);
    const id = agent?.id;
    if (!id || !open || !(threads.has(id) || (kind === "questions" && adopted.has(id)))) return next();
    const call = (kind === "questions" ? request.wait?.callId : request.callId) || null;
    const key = `${id}:${call || crypto.randomUUID()}`;
    const theirs = request.signal;
    const mine = new AbortController();
    try {
      request.signal = theirs ? AbortSignal.any([theirs, mine.signal]) : mine.signal;
    } catch {} // a request dsh froze: its prompt stays until it's answered there, and its answer is ignored
    const questions = (request.questions || []).map((q) => ({ id: str(q.id, 200), question: str(q.question), header: str(q.header, 300), detail: str(q.detail, 4000), multiSelect: !!q.multiSelect, options: (q.options || []).map((o) => ({ label: str(o.label, 500), description: str(o.description, 1000) })) }));
    const msg = kind === "approval" ? { t: "ask", ask: key, id, kind, call, tool: str(request.toolName, 200), reason: str(said(request.displayReason) || request.reason, 4000) } : { t: "ask", ask: key, id, kind, call, timed: !!request.wait?.timed, questions };
    return new Promise((resolve, reject) => {
      let over = false;
      const a = { msg, agent, call, alone: false, late: false };
      const end = () => {
        over = true;
        theirs?.removeEventListener("abort", onAbort);
      };
      // agentbook's answer: dsh's own prompt closes.
      a.answer = (value) => {
        if (over) return;
        end();
        asks.delete(key);
        mine.abort(new Error("Answered on agentbook"));
        resolve(kind === "approval" ? (value === "allow" || value === "allowed-once" ? "allowed-once" : "rejected") : value);
      };
      // agentbook went away, and dsh had nothing of its own to ask with: as dsh does without an answerer.
      a.drop = () => {
        if (over) return;
        end();
        asks.delete(key);
        if (kind === "approval") resolve("unavailable");
        else reject(a.error || new Error("no user-questions answerer accepted the request"));
      };
      // The request ended in dsh (the turn stopped, or a question's wait ran out: then it's continued, and an answer
      // from agentbook still goes, through dsh's questions).
      function onAbort() {
        if (over) return;
        end();
        if (kind === "questions" && request.wait?.timed && call) {
          a.late = true;
          a.alone = false;
        } else {
          asks.delete(key);
          send({ t: "settled", ask: key, value: null });
        }
        reject(theirs.reason);
      }
      theirs?.addEventListener("abort", onAbort, { once: true });
      asks.set(key, a);
      send(msg);
      // dsh's own answerers.
      Promise.resolve()
        .then(next)
        .then(
          (v) => {
            if (over) return;
            // No page had it open: agentbook's answer it is.
            if (kind === "approval" && v === "unavailable") return void (a.alone = true);
            end();
            asks.delete(key);
            send({ t: "settled", ask: key, value: kind === "approval" ? v : v?.answers || null });
            resolve(v);
          },
          (e) => {
            if (over) return;
            if (theirs?.aborted) return onAbort();
            // Nothing in dsh to ask with (no page, no answerer): agentbook's answer it is.
            a.alone = true;
            a.error = e;
            if (!open) a.drop();
          },
        );
    });
  }

  // An answer from agentbook: to a question still waiting, or to one whose wait in dsh ran out.
  function answered(key, value) {
    const a = asks.get(key);
    if (!a) return;
    if (!a.late) return a.answer(value);
    asks.delete(key);
    try {
      const questions = svc.questions?.userQuestions;
      if (questions && value?.answers) questions.answer(a.agent, a.call, { answers: value.answers });
    } catch (e) {
      log(`agentbook: a late answer to ${key}: ${e.message}`);
    }
  }

  /* ---------- what dsh says ---------- */

  ctx.on("session/event", (session, e) => {
    const id = session?.id;
    if (!id || !e?.type) return;
    note(id, session.header);
    const sent = !own && sized(e);
    if (sent) send({ t: "event", id, e: sent });
    // A continued question answered in dsh's app: agentbook's goes.
    if (e.type === "user/message" && e.data?.source?.kind === "user-question-reply")
      for (const [key, a] of asks)
        if (a.late && a.call === e.data.source.callId && key.startsWith(`${id}:`)) {
          asks.delete(key);
          send({ t: "settled", ask: key, value: null });
        }
  });
  ctx.on("agent/created", ({ agent } = {}) => {
    if (seen(agent)) note(agent.id, agent.session?.header);
  });
  ctx.on("agent/status", ({ agent, status } = {}) => {
    const id = seen(agent)?.id;
    if (!note(id, agent?.session?.header, status) || own) return;
    send({ t: "status", id, status });
  });
  ctx.on("agent/error", ({ agent, turn, step, error } = {}) => {
    const id = seen(agent)?.id;
    if (!note(id, agent?.session?.header) || own) return;
    send({ t: "error", id, turn: turn ?? null, step: step ?? null, error: messageOf(error) });
  });
  ctx.on("agent/disposed", ({ agent } = {}) => {
    const id = agent?.id;
    if (!id) return;
    if (agents.get(id) === agent) agents.delete(id);
    if (!sessions.has(id)) return;
    if (!own) send({ t: "gone", id });
    sessions.delete(id);
  });
  ctx.on("subagent/start", (info = {}) => {
    if (!info.id || own) return;
    if (!ws && !stopped && Date.now() - lastTry > QUIET_MS) connect();
    send({ t: "subagent", id: info.id, parent: info.parentSessionId || null, provider: info.provider || null, state: "start" });
  });
  ctx.on("subagent/end", (info = {}) => {
    if (!info.id || own) return;
    send({ t: "subagent", id: info.id, parent: info.parentSessionId || null, provider: info.provider || null, state: "end", reason: info.stopReason || null });
  });

  const stop = () => {
    stopped = true;
    open = false;
    clearTimeout(modelsRetry);
    try {
      ws?.close();
    } catch {}
    ws = null;
  };
  if (typeof ctx.effect === "function") ctx.effect(() => stop);
  else ctx.on?.("dispose", stop);
  connect();
}

export default { name, apply };
