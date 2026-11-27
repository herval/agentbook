// Claude Agent: Claude Managed Agents, Anthropic's agents in a sandbox of theirs, on this machine's API key. Each
// thread is one of its sessions (a post whose proc is "claude-agent:<session id>", or "managed:<session id>" for one
// from before it had one name), and nothing of it runs here but this runtime, which reads the session's events and
// answers what it asks. Its name stays Claude Agent, as Anthropic asks of what's built on it.
//
// An agent and an environment are made once, when the key is connected, and every session overrides what it needs of
// the agent (its model, what it's told, its tools). Its events are read with a stream that's open only while it
// runs: opened, then its history read past what's been seen, as the stream carries only what comes after it opens. So
// a reader coming back (this machine woke, agentbook-cli restarted) misses nothing, and costs nothing while it waits.
//
// agentbook's tools go to it as custom tools, which the session pauses for and this runtime answers, so it needs no
// address of ours to reach. It gets all of them, as every agent does; the files they read are its sandbox's, never
// this machine's (sandboxDisk).

import { RUNTIMES, runtimeOfProc } from "../../../shared/runtimes.ts";
import type { Session } from "../../../shared/types.ts";
import { addSay, addTool, blank, iso, liveOf, short, summaryOf, toolDone } from "../kit/steps.ts";
import type { DriverDigest } from "../kit/steps.ts";
import { backoff, callApi, filesOn, githubRepo, keptFile, linkPr, offBy, openEvents, remoteRow } from "../kit/remote.ts";
import type { Attached, CallOpts, GithubRepo, Kept } from "../kit/remote.ts";
import type { Runtime, RuntimeContext, SetupValues, StartRequest } from "../runtime.ts";

const AGENT = "claude-agent";
const NAME = "Claude Agent";
const BASE = () => process.env.AGENTBOOK_ANTHROPIC_URL || "https://api.anthropic.com";
const OUTPUTS = "/mnt/session/outputs";
const UPLOADS = "/mnt/session/uploads";
const GITHUB_MCP = "https://api.githubcopilot.com/mcp/";
const CONSOLE = "https://platform.claude.com/sessions";
const DEFAULT_MODEL = "claude-opus-5-5";
const MODELS = [
  { id: "claude-opus-5-5", name: "Opus 5.5" },
  { id: "claude-sonnet-5-5", name: "Sonnet 5.5" },
  { id: "claude-haiku-5-5", name: "Haiku 5.5" },
  { id: "claude-fable-5-1", name: "Fable 5.1" },
];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
// What it may use in its sandbox runs by itself, unless Anthropic's own check of each call says to ask.
const PERMISSION = { type: "auto" };
// A tool call of its session's, kept until it's answered: one of agentbook's tools (`custom`) or one of its own.
interface Call {
  id: string;
  name: string;
  input: Record<string, unknown>;
  custom: boolean;
}
// Why its session went idle, as its API says.
interface StopReason {
  type: string;
  event_ids?: string[];
}
// What's been read of a thread's session: its steps, the events seen (by id), the tool calls it made, those answered
// (`done`) and being answered (`acting`), and its status, as its events say it.
interface Conv {
  digest: DriverDigest;
  seen: Set<string>;
  calls: Map<string, Call>;
  done: Set<string>;
  acting: Set<string>;
  status: string | null;
  stop: StopReason | null;
  busy: boolean;
  loaded: Promise<void> | null;
  reading: boolean;
  again: boolean;
  ended: boolean;
  repo: GithubRepo | null;
  noted: Set<string>;
  // Why it can't go on (it reached its budget).
  blocked?: string;
  // What it has cost so far, in words.
  cost?: string;
  model?: string;
}

const textOf = (content) => (Array.isArray(content) ? content : []).filter((b) => b?.type === "text" && b.text).map((b) => b.text).join("\n\n");
const running = (c: Conv) => c.status === "running" || c.status === "queued";
const dollars = (cost) => {
  const cents = Number(cost?.amount);
  return Number.isFinite(cents) ? `$${(cents / 100).toFixed(2)}${cost.currency && cost.currency !== "USD" ? ` ${cost.currency}` : ""}` : null;
};

export function createClaudeAgent(): Runtime {
  let ctx: RuntimeContext = null;
  const log = (line: string) => ctx?.log(line);
  // AGENTBOOK_CLAUDE_AGENT=0 leaves it off, and so does AGENTBOOK_MANAGED=0, its name from before it had one.
  const off = offBy("AGENTBOOK_CLAUDE_AGENT", "AGENTBOOK_MANAGED");
  const enabled = !off;
  const kept = keptFile(AGENT); // { key, github_token, budget, agent_id, environment_id, vault_id }
  const convs = new Map<string, Conv>(); // post -> what's been read of its session
  let lastError = null;

  const conv = (id: string): Conv => convs.get(id) || convs.set(id, { digest: blank(), seen: new Set(), calls: new Map(), done: new Set(), acting: new Set(), status: null, stop: null, busy: false, loaded: null, reading: false, again: false, ended: false, repo: null, noted: new Set() }).get(id);
  const post = (id: string) => ctx.state.sessions[id];
  // Its threads: their procs are "claude-agent:<session id>", or "managed:<session id>" from before.
  const mine = (s: Session | undefined) => runtimeOfProc(s?.proc) === AGENT;
  const headers = (key) => ({ "x-api-key": key, "anthropic-version": "2026-10-21", "anthropic-beta": "managed-agents-2026-04-01" });
  const call = async (method: string, route: string, opts: CallOpts = {}, key = kept.read().key) => {
    if (!key) throw new Error(`${NAME} isn't connected on this machine: add its API key on Add agents.`);
    return callApi(NAME, `${BASE()}${route}`, { method, headers: headers(key), ...opts });
  };

  /* ---------- connecting ---------- */

  const exists = async (route, key) => {
    try {
      await call("GET", route, {}, key);
      return true;
    } catch (e) {
      if (e.status === 404) return false;
      throw e;
    }
  };
  // The agent and environment it starts from, kept or made: made once, they cost nothing, and a key from another
  // workspace finds its own.
  async function provision(c: Kept, key: string): Promise<Kept> {
    const out = { ...c };
    if (!out.agent_id || !(await exists(`/v1/agents/${out.agent_id}`, key))) out.agent_id = (await call("POST", "/v1/agents", { body: { name: "agentbook", model: DEFAULT_MODEL, tools: [{ type: "agent_toolset_20260401", default_config: { permission_policy: PERMISSION } }] } }, key)).id;
    // Its sandboxes reach package registries and the MCP servers a session names, and nothing else.
    if (!out.environment_id || !(await exists(`/v1/environments/${out.environment_id}`, key))) out.environment_id = (await call("POST", "/v1/environments", { body: { name: "agentbook", config: { type: "cloud", networking: { type: "limited", allow_package_managers: true, allow_mcp_servers: true } } } }, key)).id;
    return out;
  }
  // Where it keeps the GitHub token for its GitHub tools (opening pull requests). The token itself is sent to
  // Anthropic with each repo a session clones, and to this vault: only ever one you gave it for that. A token that's
  // replaced or forgotten doesn't stay there.
  const dropVault = (c: Kept, key: string) => (c.vault_id ? call("DELETE", `/v1/vaults/${c.vault_id}`, {}, key).catch((e) => log(`claude-agent vault: ${e.message}`)) : null);
  async function githubVault(c: Kept, key: string): Promise<Kept> {
    await dropVault(c, key);
    if (!c.github_token) return { ...c, vault_id: undefined };
    const vault = await call("POST", "/v1/vaults", { body: { display_name: "agentbook" } }, key);
    await call("POST", `/v1/vaults/${vault.id}/credentials`, { body: { display_name: "GitHub", auth: { type: "static_bearer", mcp_server_url: GITHUB_MCP, token: c.github_token } } }, key);
    return { ...c, vault_id: vault.id };
  }
  // Connect this machine: its key, tried right here, and optionally a GitHub token and what a thread may spend (in
  // dollars). `{ disconnect: true }` forgets the key; threads there go on there, unread.
  async function configure({ disconnect, key, github_token, budget }: SetupValues) {
    const was = kept.read();
    if (disconnect) {
      await dropVault(was, was.key);
      const { key: _k, github_token: _g, vault_id: _v, ...rest } = was;
      kept.write(rest);
      lastError = null;
      return connection();
    }
    const use = key || was.key;
    if (!use) throw new Error("Paste its API key.");
    await call("GET", "/v1/agents?limit=1", {}, use);
    let c = await provision({ ...was, key: use, ...(github_token !== undefined ? { github_token: github_token || undefined } : {}), ...(budget !== undefined ? { budget: budget || undefined } : {}) }, use);
    if (github_token !== undefined || (c.github_token && !c.vault_id)) c = await githubVault(c, use);
    kept.write(c);
    lastError = null;
    announce();
    return connection();
  }
  const announce = () => ctx.emit({ e: "agent", agent: AGENT, name: NAME, kind: AGENT });
  // What Settings → Agents shows of it: the fields its form (RUNTIMES["claude-agent"].setup) names, and never the key.
  function connection() {
    const c = kept.read();
    return { connected: !!c.key, github: !!c.github_token, budget: c.budget || null, error: lastError };
  }

  /* ---------- what a session is told, and can use ---------- */

  // The proc its sandbox's tool calls come from: its thread's own, which for one from before is "managed:<id>".
  const proc = (id: string) => post(id)?.proc || `${AGENT}:${id}`;
  const mcp = (method, params, who) => ctx.mcpCall({ jsonrpc: "2.0", id: 1, method, params }, who);
  async function offered() {
    const who = { proc: `${AGENT}:hello` };
    const hello = await mcp("initialize", {}, who);
    const listed = await mcp("tools/list", {}, who);
    const tools = listed?.result?.tools || [];
    return { instructions: hello?.result?.instructions || "", tools: tools.map((t) => ({ type: "custom", name: t.name, description: t.description, input_schema: t.inputSchema })) };
  }
  const told = (repo: GithubRepo | null, instructions: string, c: Kept) =>
    [
      instructions,
      `You work in a sandbox in the cloud, not on the person's computer, and what you make stays there unless you push it or hand it over. ${repo ? `${repo.owner}/${repo.name} is checked out at /workspace/${repo.name}.` : "No repo is checked out."}`,
      repo && (c.github_token ? "When the work is ready, push a branch and open a pull request with your GitHub tools." : "You have no GitHub credentials: say what you changed in your reply, or hand it over as a file."),
      `To hand over a file, save it under ${OUTPUTS} and give that path to ab_file.`,
    ]
      .filter(Boolean)
      .join("\n\n");

  // A thread's files, into its sandbox: -> the resources holding them, and what the agent is told of them.
  async function upload(files: Attached[]) {
    const { ready, missed } = filesOn(files);
    const resources = [];
    const lines = [];
    for (const f of ready) {
      const form = new FormData();
      form.set("file", new Blob([f.bytes]), f.name);
      const up = await call("POST", "/v1/files", { form, timeout: 120e3 });
      const mount_path = `${UPLOADS}/${f.name.replace(/[^\w.-]+/g, "_")}`;
      resources.push({ type: "file", file_id: up.id, mount_path });
      lines.push(`[${f.name} is at ${mount_path}]`);
    }
    for (const name of missed) lines.push(`[${name} couldn't be sent to your sandbox]`);
    return { resources, lines };
  }

  // Its files, for the tools that hand them over: what it saved in its outputs folder.
  const sandboxDisk = (id: string) => {
    const find = async (p) => {
      const rel = String(p).startsWith(`${OUTPUTS}/`) ? String(p).slice(OUTPUTS.length + 1) : null;
      if (!rel) return null;
      const list = (await call("GET", `/v1/files?scope_id=${encodeURIComponent(id)}&limit=1000`)).data || [];
      return list.find((f) => f.filename === rel || f.filename === rel.split("/").pop() || f.filename === `${OUTPUTS}/${rel}`) || null;
    };
    return {
      home: OUTPUTS,
      async stat(p) {
        const f = await find(p);
        return f ? { size: f.size_bytes ?? f.size ?? 0 } : null;
      },
      async read(p) {
        const f = await find(p);
        if (!f) throw new Error(`No file at ${p}`);
        return call("GET", `/v1/files/${f.id}/content`, { raw: true, timeout: 300e3 });
      },
    };
  };

  /* ---------- its events ---------- */

  // Its turn, going or over, as its session says. The core starts one only on a thread that isn't in one already (a
  // session that was mid-turn when this process stopped, its post says so already), and ends one only that's going
  // or that now says something else (`text`).
  function setBusy(id: string, busy: boolean, text?: string) {
    const c = conv(id);
    if (!post(id)) return;
    ctx.emit(busy ? { e: "turn.start", thread: id } : { e: "turn.end", thread: id, ...(text ? { text } : {}) });
    const was = c.busy;
    c.busy = busy;
    ctx.emit({ e: "changed", thread: id, save: was && !busy });
  }
  function linkIt(id: string, text?: string) {
    ctx.emit({ e: "fact", op: { t: "session.attach", post: id, key: "remote", type: "link", title: NAME, data: { url: `${CONSOLE}/${id}`, title: "Open in the Claude Console", text: text || "Runs in Anthropic's cloud." } } });
  }
  function ended(id: string, reason: string) {
    const c = conv(id);
    if (c.ended) return;
    c.ended = true;
    c.busy = false;
    ctx.emit({ e: "gone", thread: id, reason, ended: new Date().toISOString() });
    ctx.emit({ e: "changed", thread: id, save: true });
  }

  // One event, into its post's steps and what's known of its session. Those already on the post (`known`, read back
  // from its history) don't come again.
  function take(id: string, e, known?: { has(id: string): boolean }) {
    const c = conv(id);
    if (!e?.id || c.seen.has(e.id) || /^event_/.test(String(e.type))) return;
    c.seen.add(e.id);
    const d = c.digest;
    const at = iso(e.processed_at || e.created_at) || new Date().toISOString();
    const dir = c.repo ? `/workspace/${c.repo.name}` : "";
    switch (e.type) {
      case "user.message":
        d.turn++;
        c.status = "queued";
        break;
      case "user.custom_tool_result":
        c.done.add(e.custom_tool_use_id);
        c.status = "queued";
        break;
      case "user.tool_confirmation":
        c.done.add(e.tool_use_id);
        c.status = "queued";
        break;
      case "agent.message": {
        const text = textOf(e.content);
        if (!text.trim()) break;
        addSay(d, { id: e.id, at, text });
        if (!known?.has(e.id)) ctx.emit({ e: "message", thread: id, mid: e.id, from: "agent", via: "dash", text, when: at });
        break;
      }
      case "agent.tool_use":
      case "agent.mcp_tool_use":
      case "agent.custom_tool_use":
        addTool(d, { id: e.id, at, name: e.name, args: e.input, cwd: dir });
        c.calls.set(e.id, { id: e.id, name: e.name, input: e.input || {}, custom: e.type === "agent.custom_tool_use" });
        break;
      case "agent.tool_result":
      case "agent.mcp_tool_result": {
        const text = textOf(e.content);
        toolDone(d, e.tool_use_id, { at, error: e.is_error ? text || "It failed." : null, output: text });
        // A pull request its GitHub tools opened.
        if (e.type === "agent.mcp_tool_result" && /pull_request/.test(c.calls.get(e.tool_use_id)?.name || "") && !e.is_error) linkPr(ctx, id, text, at);
        break;
      }
      case "session.status_running":
      case "session.status_rescheduled":
        c.status = "running";
        break;
      case "session.status_idle":
        c.status = "idle";
        c.stop = e.stop_reason || { type: "end_turn" };
        break;
      case "session.status_terminated":
      case "session.deleted":
        c.status = "terminated";
        break;
      case "session.error": {
        const why = e.error?.message || "It hit an error.";
        addSay(d, { id: e.id, at, text: why });
        if (e.error?.retry_status?.type !== "retrying" && !known?.has(e.id)) ctx.emit({ e: "failed", thread: id, why, mid: e.id, when: at });
        break;
      }
    }
  }

  // What its session's state calls for, each time it may have changed: it can't be asked twice for the same thing.
  async function act(id: string) {
    const c = conv(id);
    if (c.status === "terminated") return ended(id, `${NAME}'s session ended.`);
    if (running(c)) return setBusy(id, true);
    if (c.status !== "idle") return;
    if (c.stop?.type !== "requires_action") noteCost(id);
    if (c.stop?.type === "budget_reached") {
      c.blocked = "It reached what a thread may spend. Raise the budget in the Claude Console and it goes on.";
      return setBusy(id, false, "Stopped at its budget");
    }
    if (c.stop?.type !== "requires_action") return setBusy(id, false);
    setBusy(id, true);
    for (const eid of c.stop.event_ids || []) {
      const it = c.calls.get(eid);
      if (!it || c.done.has(eid) || c.acting.has(eid)) continue;
      if (it.custom) runTool(id, it);
      else askAbout(id, it);
    }
  }

  // What it has cost so far, on its link, each time a turn ends.
  async function noteCost(id: string) {
    const c = conv(id);
    const cost = dollars((await call("GET", `/v1/sessions/${id}`).catch(() => null))?.usage?.list_cost);
    if (!cost || cost === c.cost) return;
    c.cost = cost;
    linkIt(id, `${cost} so far.`);
  }

  // One of agentbook's tools, called from its sandbox: answered in the background, as ab_ask can wait for you.
  function runTool(id: string, it: Call) {
    const c = conv(id);
    c.acting.add(it.id);
    const at = () => new Date().toISOString();
    (async () => {
      let text;
      let error = null;
      const r = await mcp("tools/call", { name: it.name, arguments: it.input }, { proc: proc(id), cwd: c.repo ? `/workspace/${c.repo.name}` : OUTPUTS, disk: sandboxDisk(id) }).catch((e: Error) => ({ error: e, result: undefined }));
      if (r?.error) error = r.error.message || "It failed.";
      else {
        text = (r?.result?.content || []).map((b) => b.text).filter(Boolean).join("\n");
        if (r?.result?.isError) error = text || "It failed.";
      }
      toolDone(c.digest, it.id, { at: at(), error });
      await push(id, [{ type: "user.custom_tool_result", custom_tool_use_id: it.id, content: [{ type: "text", text: (error ? `It failed: ${error}` : text) || "Done." }] }]);
      c.done.add(it.id);
    })()
      .catch((e) => log(`claude-agent tool ${it.name} on ${id}: ${e.message}`))
      .finally(() => c.acting.delete(it.id));
  }

  // A call Anthropic's check won't run by itself: it waits for your OK, and the question outlives this process. Its
  // answer finds the call by the end of its id, all a question's request_id has room for.
  function askAbout(id: string, it: Call) {
    const key = it.id.slice(-40);
    if (ctx.state.questions.some((q) => q.post === id && q.request_id === key && !q.answered)) return;
    const detail = it.input?.command || it.input?.file_path || it.input?.path || it.input?.url || `${NAME} wants to go ahead with this.`;
    ctx.emit({ e: "ask", thread: id, kind: "permission", request_id: key, title: "Allow this?", tool_name: it.name, detail: short(String(detail), 400), preview: short(JSON.stringify(it.input), 4000) });
  }
  async function answer(id: string, e) {
    if (e.type !== "permission") return false;
    await load(id);
    const c = conv(id);
    const it = [...c.calls.values()].find((x) => x.id.slice(-40) === e.request_id);
    if (!it) return false;
    const yes = e.behavior === "allow";
    await push(id, [{ type: "user.tool_confirmation", tool_use_id: it.id, result: yes ? "allow" : "deny", ...(yes ? {} : { deny_message: "The person said no." }) }]);
    c.done.add(it.id);
    return true;
  }

  // Everything in its history that hasn't been seen yet. Its messages may be on the post already, from before this
  // process: a thread memory doesn't hold has been read to its end long ago.
  async function catchUp(id: string) {
    const c = conv(id);
    const known = new Set(ctx.state.messages.filter((m) => m.post === id).map((m) => m.id));
    const cold = ctx.state.cold?.has(id);
    for (let page = null; ; ) {
      const r = await call("GET", `/v1/sessions/${id}/events?beta=true&order=asc${page ? `&page=${encodeURIComponent(page)}` : ""}`);
      for (const e of r.data || []) take(id, e, cold ? { has: () => true } : known);
      page = r.next_page;
      if (!page) break;
    }
    ctx.emit({ e: "changed", thread: id });
  }
  // Once per process, for what needs its history (its steps, an answer) before any stream is open.
  function load(id: string) {
    const c = conv(id);
    if (!c.loaded) {
      c.repo = c.repo || githubRepo(post(id)?.repo);
      c.loaded = catchUp(id).catch((e) => {
        c.loaded = null;
        throw e;
      });
    }
    return c.loaded;
  }

  // Keep reading a session while it runs. One reader per post; it ends when the session stops, and whatever starts it
  // again (a message, an answer) starts this again.
  function follow(id: string) {
    const c = conv(id);
    if (c.reading) return void (c.again = true);
    c.reading = true;
    read(id)
      .catch((e) => log(`claude-agent reading ${id}: ${e.message}`))
      .finally(() => {
        c.reading = false;
        if (c.again) {
          c.again = false;
          follow(id);
        }
      });
  }
  async function read(id: string) {
    const c = conv(id);
    const wait = backoff();
    for (;;) {
      c.again = false;
      if (!kept.read().key) return;
      const stop = new AbortController();
      try {
        const events = await openEvents(NAME, `${BASE()}/v1/sessions/${id}/events/stream?beta=true`, { headers: headers(kept.read().key), signal: stop.signal });
        await catchUp(id);
        await act(id);
        wait.reset();
        if (!running(c)) return;
        for await (const e of events) {
          take(id, e);
          ctx.emit({ e: "changed", thread: id });
          await act(id);
          if (!running(c)) return;
        }
      } catch (e) {
        if (e.status === 404) return ended(id, `${NAME}'s session is gone.`);
        if (e.status === 401 || e.status === 403) {
          lastError = e.message;
          return;
        }
        if (e.name !== "AbortError" && !e.quiet) log(`claude-agent stream ${id}: ${e.message}`);
      } finally {
        stop.abort();
      }
      await wait.next();
    }
  }

  // Send events to its session, and read what they start.
  async function push(id: string, events: Record<string, unknown>[]) {
    const c = conv(id);
    await call("POST", `/v1/sessions/${id}/events?beta=true`, { body: { events } });
    c.status = "queued";
    setBusy(id, true);
    follow(id);
  }

  // A message, as the core's delivery makes it of what's queued, with the files you attached going into its sandbox.
  async function send(id: string, text: string, files: Attached[] = []) {
    await load(id);
    const c = conv(id);
    if (c.status === "terminated") throw new Error(`${NAME}'s session has ended.`);
    if (c.stop?.type === "budget_reached" && c.status === "idle") throw new Error(c.blocked || "It reached its budget.");
    const { resources, lines } = await upload(files);
    for (const r of resources) await call("POST", `/v1/sessions/${id}/resources`, { body: r });
    await push(id, [{ type: "user.message", content: [{ type: "text", text: [text, ...lines].filter(Boolean).join("\n\n") }] }]);
  }

  async function start({ prompt, shown = prompt, files = [], lid, model, effort, repo }: StartRequest) {
    // The server sends a start again when this process stopped before answering: a session costs money, so it's the
    // same one.
    const again = Object.values(ctx.state.sessions).find((s) => s.launch === lid && mine(s));
    if (again) return { id: again.id };
    const cfg = kept.read();
    if (!cfg.key) throw new Error(`${NAME} isn't connected on this machine: add its API key on Add agents.`);
    const gh = repo ? githubRepo(repo) : null;
    if (repo && !gh) throw new Error(`${NAME} can only clone repos on GitHub.`);
    const { instructions, tools } = await offered();
    const { resources, lines } = await upload(files);
    const github = gh && cfg.github_token && cfg.vault_id;
    const session = await call("POST", "/v1/sessions", {
      body: {
        agent: {
          type: "agent_with_overrides",
          id: cfg.agent_id,
          model: { id: model || DEFAULT_MODEL, ...(effort ? { effort } : {}) },
          system: told(gh, instructions, cfg),
          tools: [{ type: "agent_toolset_20260401", default_config: { permission_policy: PERMISSION } }, ...tools, ...(github ? [{ type: "mcp_toolset", mcp_server_name: "github", default_config: { permission_policy: PERMISSION } }] : [])],
          ...(github ? { mcp_servers: [{ type: "url", name: "github", url: GITHUB_MCP }] } : {}),
        },
        environment_id: cfg.environment_id,
        title: short(shown, 100),
        ...(gh || resources.length ? { resources: [...(gh ? [{ type: "github_repository", url: gh.url, ...(cfg.github_token ? { authorization_token: cfg.github_token } : {}) }] : []), ...resources] } : {}),
        ...(github ? { vault_ids: [cfg.vault_id] } : {}),
        ...(cfg.budget ? { budget: { type: "limit", max_list_cost: { amount: String(Math.round(Number(cfg.budget) * 100)), currency: "USD" } } } : {}),
      },
    });
    const id = session.id;
    const c = conv(id);
    c.repo = gh;
    c.model = model || DEFAULT_MODEL;
    c.digest.model = c.model;
    const now = new Date().toISOString();
    // Its thread works on the repo it cloned there, with no folder here.
    ctx.emit({ e: "thread", thread: id, agent: AGENT, agent_name: NAME, kind: AGENT, cwd: "", root: "", repo: gh?.key || "", branch: "", host: "cloud", launch: lid, started: now, updated: now, prompt: short(shown, 2000) });
    ctx.emit({ e: "message", thread: id, from: "human", via: "dash", text: shown, resume: lid });
    linkIt(id);
    ctx.emit({ e: "changed", thread: id, save: true });
    c.loaded = Promise.resolve();
    await push(id, [{ type: "user.message", content: [{ type: "text", text: [prompt, ...lines].filter(Boolean).join("\n\n") }] }]);
    return { id };
  }

  async function interrupt(id: string) {
    await load(id);
    const c = conv(id);
    await call("POST", `/v1/sessions/${id}/events?beta=true`, { body: { events: [{ type: "user.interrupt" }] } });
    // Paused for you, nothing is reading it, and the turn's over for all that shows here.
    if (!running(c)) {
      c.stop = { type: "end_turn" };
      setBusy(id, false);
    }
  }

  return {
    id: AGENT,
    info: RUNTIMES[AGENT],
    // It never shows what you said from its session's history, so there's nothing of agentbook's to see twice.
    echoes: "self",
    owns: (id) => id === AGENT && ctx?.state.agents[id]?.kind === AGENT,
    connect(c) {
      ctx = c;
      if (!enabled) return;
      if (kept.read().key) announce();
      for (const s of Object.values(ctx.state.sessions)) {
        if (!mine(s)) continue;
        if (s.state !== "done") follow(s.id);
        if (ctx.pending(s.id).length) ctx.deliver(s.id);
      }
    },
    health: () => ({ enabled, connected: !!kept.read().key, error: lastError }),
    start,
    send: (id, text, files) => send(id, text, files),
    answer,
    interrupt,
    read: async (id) => {
      await load(id).catch((e) => log(`claude-agent history ${id}: ${e.message}`));
      return conv(id).digest;
    },
    live: (s) => liveOf(convs.get(s.id)?.digest),
    summary: (s) => summaryOf(convs.get(s.id)?.digest, s),
    working: (id) => !!convs.get(id)?.busy,
    blocked: (s) => (s.state === "done" ? `${NAME}'s session has ended.` : convs.get(s.id)?.stop?.type === "budget_reached" ? convs.get(s.id).blocked || null : null),
    resumeCommand: () => null,
    models: { list: () => ({ list: MODELS.map((m) => ({ ...m, efforts: EFFORTS })), default: DEFAULT_MODEL, efforts: EFFORTS }) },
    // Its agents run in Anthropic's cloud, reached with the key this machine keeps.
    remote: { machine: () => "cloud", link: () => ({ connected: !!kept.read().key, state: kept.read().key ? "connected" : "off" }) },
    setup: { configure: (v) => configure(v as SetupValues), connection },
    row: () => remoteRow({ off, error: lastError, connected: !!kept.read().key, where: "Runs in Anthropic's cloud, on your API key." }),
  };
}
