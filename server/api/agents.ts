import fs from "node:fs";
import { emojiOf, pictureFile, prunePictures, savePicture } from "../avatars.ts";
import { agentPublic, fileForOthers, workShown } from "../policy.ts";
import { outOfMemory } from "../../plugin/shared/store.ts";
import { threadKey } from "../../plugin/shared/routine-threads.ts";
import { blobs, relay } from "../core/state.ts";
import { fail, ok, readBody, route, str } from "../core/http.ts";
import type { Req, Res, Viewer } from "../core/http.ts";
import type { AgentRef, Answer, ReadAnswer } from "../core/types.ts";
import { agentRef, agentsById, deviceFor, isOwner, markAll, ownerOf } from "../core/refs.ts";
import { sharedOf } from "../core/follows.ts";
import { readOf, steer } from "../core/commands.ts";
import { machineSeen } from "./views.ts";
import { withPeek } from "./queries.ts";
import { threadsOn } from "./routines.ts";
import { agentFollowFor } from "./contacts.ts";
import { SIGN_IN, isProviderRuntime } from "../../plugin/shared/runtime-providers.ts";
import { INSTALLABLE, UPDATABLE } from "../../plugin/shared/runtimes.ts";
import { AGENT_CONFIGS } from "../../plugin/shared/agent-config.ts";

// The kinds of agent a machine runs, for the Add agents page.
route("GET", "/api/runtimes", async (req, res, { query }) => {
  const D = deviceFor(req, query.get("machine"));
  if (!D) return fail(res, 403, "Only a machine's owner can see that.");
  await readOf(res, D, "read.runtimes", {});
});
// What a machine's agents did before agentbook followed them, for the welcome card, and how much of it comes in.
route("GET", "/api/history", async (req, res, { query }) => {
  const D = deviceFor(req, query.get("machine"));
  if (!D) return fail(res, 403, "Only a machine's owner can see that.");
  await readOf(res, D, "read.history", {});
});
route("POST", "/api/history", async (req, res, { query }) => {
  const b = await readBody<{ machine?: string; days?: unknown; out_agents?: unknown; out_folders?: unknown; codex_tools?: unknown; claude_plugin?: unknown }>(req);
  const D = deviceFor(req, query.get("machine") || b.machine);
  if (!D) return fail(res, 403, "Only a machine's owner can pick what comes in from it.");
  if (b.days !== null && !(Number.isInteger(b.days) && (b.days as number) >= 0 && (b.days as number) <= 36500)) return fail(res, 400, "Pick a number of days, or all of them.");
  const strings = (x: unknown, max: number, len: number) => (Array.isArray(x) ? x.filter((s) => typeof s === "string" && s.length <= len).slice(0, max) : []);
  if (!relay.online(D)) return fail(res, 503, `${D.name} is off. Pick once it is back.`);
  await steer(req, res, D, "history.pick", { days: b.days, out_agents: strings(b.out_agents, 20, 40), out_folders: strings(b.out_folders, 500, 4096), codex_tools: b.codex_tools === true, claude_plugin: b.claude_plugin === true });
});
route("POST", "/api/agents", async (req, res, { query }) => {
  const b = await readBody<{ machine?: string; kind?: string; name?: string; config_dir?: string }>(req);
  const D = deviceFor(req, query.get("machine") || b.machine);
  if (!D) return fail(res, 403, "Only a machine's owner can add its agents.");
  if (!Object.hasOwn(AGENT_CONFIGS, b.kind)) return fail(res, 400, "That runtime does not support separate agent configurations.");
  if (typeof b.name !== "string" || !b.name.trim() || b.name.trim().length > 80) return fail(res, 400, "Give this agent a name of up to 80 characters.");
  if (b.config_dir != null && (typeof b.config_dir !== "string" || b.config_dir.length > 4096)) return fail(res, 400, "Enter a valid config directory.");
  if (!relay.online(D)) return fail(res, 503, `${D.name} is offline. Add an agent when it reconnects.`);
  await steer(req, res, D, "agent.create", { kind: b.kind, name: b.name.trim(), config_dir: b.config_dir?.trim() || "" });
});
route("POST", "/api/runtimes/install", async (req, res, { query }) => {
  const b = await readBody<{ machine?: string; kind?: string }>(req);
  const D = deviceFor(req, query.get("machine") || b.machine);
  if (!D) return fail(res, 403, "Only a machine's owner can install agents on it.");
  if (!(INSTALLABLE as string[]).includes(b.kind)) return fail(res, 400, "That runtime has no in-app installer.");
  if (!relay.online(D)) return fail(res, 503, `${D.name} is off. Install once it is back.`);
  await steer(req, res, D, "runtime.install", { kind: b.kind });
});
// Its app updated on that machine, by the app's own update command there: only the runtime's name goes.
route("POST", "/api/runtimes/update", async (req, res, { query }) => {
  const b = await readBody<{ machine?: string; kind?: string }>(req);
  const D = deviceFor(req, query.get("machine") || b.machine);
  if (!D) return fail(res, 403, "Only a machine's owner can update agents on it.");
  if (!(UPDATABLE as string[]).includes(b.kind)) return fail(res, 400, "agentbook can't update that agent.");
  if (!relay.online(D)) return fail(res, 503, `${D.name} is off. Update once it is back.`);
  await steer(req, res, D, "runtime.update", { kind: b.kind });
});
for (const action of ["configure", "login"] as const) route("POST", `/api/runtimes/${action}`, async (req, res, { query }) => {
  const b = await readBody<Record<string, string>>(req);
  const D = deviceFor(req, query.get("machine") || b.machine);
  if (!D) return fail(res, 403, "Only a machine's owner can set up its providers.");
  if (!isProviderRuntime(b.kind) || (action === "login" && !SIGN_IN.includes(b.kind))) return fail(res, 400, "That runtime has no provider setup here.");
  if (!relay.online(D)) return fail(res, 503, `${D.name} is off. Set it up once it is back.`);
  const args: Record<string, string> = { kind: b.kind };
  for (const k of action === "login" ? ["step", "code"] : ["provider", "model", "endpoint", "key"]) if (b[k] != null) args[k] = b[k];
  await steer(req, res, D, `runtime.${action}`, args, { wait: 60e3 });
});
// A machine's connection to an OpenClaw gateway: a setup code, or its address and token (relayed to the machine,
// never kept here), and whether the gateway has approved agentbook as a device yet.
route("GET", "/api/openclaw", async (req, res, { query }) => {
  const D = deviceFor(req, query.get("machine"));
  if (!D) return fail(res, 403, "Only a machine's owner can see that.");
  await readOf(res, D, "read.openclaw", {});
});
route("POST", "/api/openclaw", async (req, res, { query }) => {
  const b = await readBody<{ machine?: string; setup_code?: string; url?: string; token?: string; password?: string; disconnect?: boolean; admin?: boolean }>(req);
  const D = deviceFor(req, query.get("machine") || b.machine);
  if (!D) return fail(res, 403, "Only a machine's owner can do that.");
  const args: Record<string, unknown> = {};
  for (const k of ["setup_code", "url", "token", "password"]) if (b[k] != null) args[k] = str(b[k], k === "setup_code" ? 8000 : 500);
  if (b.disconnect) args.disconnect = true;
  // Admin, asked of the gateway for this machine's owner (their messages and starts, Run now and Pause).
  else if (b.admin) args.admin = true;
  await steer(req, res, D, "openclaw.pair", args, { done: (r) => { const { ok: _, ...rest } = r; return rest; } });
});
// A machine's connection to the agents that run on their vendor's computers (Claude Agent, Devin): its key is relayed
// to the machine and never kept here.
route("GET", "/api/remote-agents", async (req, res, { query }) => {
  const D = deviceFor(req, query.get("machine"));
  if (!D) return fail(res, 403, "Only a machine's owner can see that.");
  await readOf(res, D, "read.remote", {});
});
route("POST", "/api/remote-agents", async (req, res, { query }) => {
  const b = await readBody<{ machine?: string; vendor?: string; key?: string; org?: string; github_token?: string; budget?: string; disconnect?: boolean }>(req);
  const D = deviceFor(req, query.get("machine") || b.machine);
  if (!D) return fail(res, 403, "Only a machine's owner can do that.");
  const args: Record<string, unknown> = { vendor: str(b.vendor, 20) };
  for (const k of ["key", "org", "github_token", "budget"]) if (b[k] != null && (b[k] !== "" || k === "github_token")) args[k] = str(b[k], 500);
  if (b.disconnect) args.disconnect = true;
  await steer(req, res, D, "remote.connect", args, { done: (r) => { const { ok: _, ...rest } = r; return rest; } });
});

// Who can see an agent (and, by default, its posts), and a post: private or public. A post's own setting (null:
// as its agent) and whether others see its work: its steps, its agent's files.
route("POST", "/api/agents/:id/visibility", async (req, res, { params }) => {
  const b = await readBody<{ visibility?: string }>(req);
  const a = agentRef(params.id);
  if (!a || !(isOwner(req, a.D) || agentPublic(a.a))) return fail(res, 404, "No such agent");
  if (!isOwner(req, a.D)) return fail(res, 403, "Only its owner can do that.");
  if (!["private", "public"].includes(b.visibility)) return fail(res, 400, "Private or public?");
  markAll(a, "agent", { t: "agent.visibility", visibility: b.visibility });
  ok(res);
});
// Deactivated: off its owner's sidebar and feed, and no new threads. Existing threads and requests continue.
route("POST", "/api/agents/:id/hidden", async (req, res, { params }) => {
  const b = await readBody<{ hidden?: boolean }>(req);
  const a = agentRef(params.id);
  if (!a || !(isOwner(req, a.D) || agentPublic(a.a))) return fail(res, 404, "No such agent");
  if (!isOwner(req, a.D)) return fail(res, 403, "Only its owner can do that.");
  markAll(a, "agent", { t: "agent.hidden", hidden: !!b.hidden });
  ok(res);
});
// Its name, as its owner calls it. It stays when its runtime says another (an OpenClaw gateway's, Claude Code's own).
route("POST", "/api/agents/:id/name", async (req, res, { params }) => {
  const b = await readBody<{ name?: string }>(req);
  const a = agentRef(params.id);
  if (!a || !(isOwner(req, a.D) || agentPublic(a.a))) return fail(res, 404, "No such agent");
  if (!isOwner(req, a.D)) return fail(res, 403, "Only its owner can do that.");
  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (!name || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)) return fail(res, 400, "Give this agent a name of up to 80 characters.");
  markAll(a, "agent", { t: "agent.rename", name });
  ok(res, { name });
});

// An agent's avatar: its picture, for anyone who can see the agent. Its address changes with the picture (?v=), so
// the browser keeps it; ?v= also picks its own one while you've set another (for the menu that goes back to it).
route("GET", "/api/agents/:id/avatar", (req, res, { params, query }) => {
  const a = agentRef(params.id);
  if (!a || !(isOwner(req, a.D) || agentPublic(a.a))) return fail(res, 404, "No such agent");
  const pic = [a.a.avatar, a.a.avatar_default].find((p) => p?.image && p.image === query.get("v")) || a.a.avatar || a.a.avatar_default;
  sendPicture(res, pic, query.get("v"));
});
export function sendPicture(res: Res, pic, v) {
  // One a machine sent is a blob; one set here is in the avatars folder.
  const file = pic?.blob && blobs.has(pic.blob) ? blobs.file(pic.blob) : pictureFile(pic);
  if (!file || !fs.existsSync(file)) return fail(res, 404, "No picture");
  res.writeHead(200, {
    "content-type": pic.type,
    "content-length": fs.statSync(file).size,
    "cache-control": v === pic.image ? "private, max-age=31536000, immutable" : "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox; default-src 'none'",
  });
  fs.createReadStream(file).pipe(res);
}
// The avatar a request asks for: a picture, an emoji, or none (null). Undefined once it has failed, saying why.
export async function avatarFrom(req: Req, res: Res) {
  if (/^image\//.test(req.headers["content-type"] || "")) {
    try {
      return savePicture(await readBody(req, true));
    } catch (e) {
      return void fail(res, 400, e.message);
    }
  }
  const b = await readBody<{ emoji?: string; avatar?: null }>(req);
  if (b.emoji !== undefined) return emojiOf(b.emoji) ? { emoji: emojiOf(b.emoji) } : void fail(res, 400, "One emoji, please.");
  return b.avatar === null ? null : void fail(res, 400, "A picture, an emoji, or none?");
}
// Set it, as its owner: a picture (the request's body, an image/* type), an emoji ({ emoji }), or back to the one
// its runtime gives it, or its letter ({ avatar: null }).
route("POST", "/api/agents/:id/avatar", async (req, res, { params }) => {
  const a = agentRef(params.id);
  if (!a || !(isOwner(req, a.D) || agentPublic(a.a))) return fail(res, 404, "No such agent");
  if (!isOwner(req, a.D)) return fail(res, 403, "Only its owner can do that.");
  const avatar = await avatarFrom(req, res);
  if (avatar === undefined) return;
  markAll(a, "agent", { t: "agent.avatar", avatar });
  prunePictures(allAgents());
  ok(res, { avatar });
});
export const allAgents = () => Object.fromEntries([...agentsById()]);

// An agent's profile.
route("GET", "/api/agents/:id", (req, res, { params }) => {
  const a = agentRef(params.id);
  const detail = a && agentDetail(a, req);
  if (!detail) return fail(res, 404, "No such agent");
  ok(res, detail);
});
function agentDetail(ref: AgentRef, req: Viewer) {
  const { D, local } = ref;
  const { mine, seen } = machineSeen(D, req);
  const agent = seen.agents.find((a) => a.id === local);
  if (!agent) return null;
  const st = D.store.state;
  const sessions = seen.sessions.filter((s) => s.agent === local);
  const keys = new Set<string>(sessions.map((s) => s.id));
  const models = [...new Set(sessions.map((s) => s.model).filter(Boolean))];
  const hosts = [...new Set(sessions.map((s) => s.host).filter(Boolean))];
  // Its skills: what its sessions can use (the newest listing wins), and how often they used each.
  const skills: Record<string, { name: string; description?: string; used: number; sessions: number }> = {};
  const newest = [...keys].map((k) => st.sessions[k]).sort((a, b) => a.started.localeCompare(b.started));
  for (const s of newest) for (const sk of s.skills || []) skills[sk.name] = { ...sk, used: 0, sessions: 0 };
  for (const s of newest)
    for (const [name, n] of Object.entries(s.skill_uses || {})) {
      skills[name] ||= { name, description: "", used: 0, sessions: 0 };
      skills[name].used += n;
      skills[name].sessions++;
    }
  const skillList = Object.values(skills).sort((a, b) => b.used - a.used || a.name.localeCompare(b.name));
  // Others see files only from posts whose work they see (whoever sees a thread does: its owner's contacts a public
  // one, the people it's shared with any), and what a skill is, not where it's kept.
  const withFiles = mine ? keys : new Set<string>(sessions.filter((s) => workShown(st.sessions[s.id], st.agents[local]) || sharedOf(req, relay.idOf(D, s.id)) === true).map((s) => s.id));
  const files = [...st.files, ...outOfMemory(st, "files", withFiles)].filter((f) => withFiles.has(f.post) && !f.embedded && !f.pending).sort((a, b) => (b.at || "").localeCompare(a.at || "")).slice(0, 60);
  const out = mine ? { agent, files, models, hosts, skills: skillList } : { agent, files: files.map(fileForOthers), models, hosts: [], skills: skillList.map(({ name, description, used, sessions: n }) => ({ name, description, used, sessions: n })) };
  const q = relay.qualify(D, out);
  return { ...q, agent: { ...q.agent, machine: D.name, offline: !relay.online(D) || !!agent.offline }, follow: mine ? null : agentFollowFor(req, ref.id || relay.idOf(D, local), ownerOf(D)?.id || null) };
}

// An agent's routines and their runs, for its owner only: they're how it's set up, like its folders. A run is read
// from its own session; Run now and Pause act on the routine, on its machine.
const routinesAgent = (req: Viewer, res: Res, id: string) => {
  const a = agentRef(id);
  if (!a || !isOwner(req, a.D)) return void fail(res, 404, "No such agent");
  return a;
};
route("GET", "/api/agents/:id/routines", async (req, res, { params }) => {
  const a = routinesAgent(req, res, params.id);
  if (a) await readOf(res, a.D, "read.agent_routines", { agent: a.local });
});
// How much of its plan's usage limits it has used, for its owner only (its machine reads them: cli/limits.ts).
route("GET", "/api/agents/:id/limits", async (req, res, { params }) => {
  const a = routinesAgent(req, res, params.id);
  if (a) await readOf(res, a.D, "read.agent_limits", { agent: a.local });
});
// With the threads started on it from its page (routine-threads.ts).
route("GET", "/api/agents/:id/routines/:job", async (req, res, { params, query }) => {
  const a = routinesAgent(req, res, params.id);
  const job = str(params.job, 500);
  if (a) await readOf(res, a.D, "read.agent_routine", { agent: a.local, job, offset: Math.max(0, Number(query.get("offset")) || 0) }, { as: (d) => ({ ...d, threads: threadsOn(threadKey(relay.idOf(a.D, a.local), job)) }) });
});
route("GET", "/api/agents/:id/routines/:job/run", async (req, res, { params, query }) => {
  const a = routinesAgent(req, res, params.id);
  if (a) await readOf(res, a.D, "read.agent_routine_run", { agent: a.local, job: str(params.job, 500), session: str(query.get("session"), 500) });
});
route("POST", "/api/agents/:id/routines/:job", async (req, res, { params }) => {
  const a = routinesAgent(req, res, params.id);
  if (!a) return;
  const { action } = await readBody<{ action?: string }>(req);
  if (!["run", "pause", "resume", "stop"].includes(action)) return fail(res, 400, "action: run, pause, resume or stop");
  await steer(req, res, a.D, "routine.do", { agent: a.local, job: str(params.job, 500), action }, { done: () => ({}) });
});
// An agent's workspace (an OpenClaw agent's own folder, on its gateway's machine), or one of its folders (?dir=), for
// its owner only.
route("GET", "/api/agents/:id/workspace", async (req, res, { params, query }) => {
  const a = routinesAgent(req, res, params.id);
  const dir = String(query.get("dir") || "").trim();
  if (a) await readOf(res, a.D, "read.agent_files", { agent: a.local, ...(dir ? { dir: str(dir, 2000) } : {}) });
});
route("GET", "/api/agents/:id/workspace/file", async (req, res, { params, query }) => {
  const a = routinesAgent(req, res, params.id);
  if (!a) return;
  const asked = String(query.get("path") || "").trim();
  if (!asked) return fail(res, 400, "Which file?");
  await readOf(res, a.D, "read.agent_file", { agent: a.local, path: str(asked, 2000) }, { as: (d) => withPeek(a.D, d) });
});

// One skill: what the listing says, its SKILL.md when its machine has it, and the sessions that used it.
route("GET", "/api/agents/:id/skills/:name", async (req, res, { params }) => {
  const name = decodeURIComponent(params.name);
  const a = agentRef(params.id);
  const mine = !!a && isOwner(req, a.D);
  if (!a || !(mine || agentPublic(a.a))) return fail(res, 404, "No such agent");
  const st = a.D.store.state;
  const sessions = Object.values(st.sessions).filter((s) => s.agent === a.local).sort((x, y) => x.started.localeCompare(y.started));
  if (!sessions.length) return fail(res, 404, "No such agent");
  let listed = null;
  for (const s of sessions) listed = (s.skills || []).find((k) => k.name === name) || listed;
  const uses = sessions
    .filter((s) => s.skill_uses?.[name])
    .reverse()
    .map((s) => ({ id: relay.idOf(a.D, s.id), title: s.title || s.ai_title || s.label, label: s.label, started: s.started, count: s.skill_uses[name] }));
  if (!listed && !uses.length) return fail(res, 404, "No such skill");
  const r = (await relay.read(a.D, "read.skill", { agent: a.local, name: str(name, 300) }, { wait: 10e3 })) as ReadAnswer<Answer & { doc?: { description?: string; body?: string } | null; file?: string }>;
  const doc = r.data?.doc || null;
  // Others see what a skill is, not its instructions or where it lives on its machine.
  ok(res, {
    name,
    description: doc?.description || listed?.description || "",
    body: mine ? doc?.body || null : null,
    file: mine && doc ? r.data.file : null,
    listed: !!listed,
    used: uses.reduce((n, u) => n + u.count, 0),
    uses,
  });
});
