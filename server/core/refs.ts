import { foldedInto } from "../../plugin/shared/store.ts";
import { machineName } from "../../plugin/shared/ids.ts";
import type { User } from "../accounts.ts";
import type { Device } from "../relay.ts";
import type { Agent } from "../../plugin/shared/types.ts";
import { accounts, relay, state } from "./state.ts";
import type { Viewer } from "./http.ts";
import type { AgentRef, PostRef } from "./types.ts";


// A post by the page's id: its machine, its id there, the post and its agent. Null when no machine has it. A copy
// folded into a post (session.fold) is that post.
export function postRef(id: string): PostRef | null {
  const r = relay.resolve(id);
  if (!r) return null;
  const into = r.D.store.state.sessions[r.local] ? null : foldedInto(r.D.store.state, r.local);
  const local = into || r.local;
  const s = r.D.store.state.sessions[local];
  return s ? { D: r.D, local, s, agent: r.D.store.state.agents[s.agent] || null, id: into ? relay.idOf(r.D, into) : id } : null;
}
export function agentRef(id: string): AgentRef | null {
  const r = relay.resolve(id);
  const a = r && r.D.store.state.agents[r.local];
  return a ? { D: r.D, local: r.local, a, id } : null;
}
// Whether an agent works in a folder of the machine that starts it. OpenClaw's agents work in their own workspace
// (Devin's and Claude Agent's where they run), so a folder means nothing to them, and the machine's gate refuses one
// it doesn't share, such as the workspace's path on the gateway's machine.
export const takesFolders = (D: Device, local: string) => relay.infoOf(D)?.[`agent:${local}`]?.folders !== false;
export const ownerOf = (D: Device): User | null => relay.ownerOf(D);
export const ownerName = (D: Device) => ownerOf(D)?.username || D.name;
// Whether the person asking is the machine's: they steer its agents, and see everything on it.
export const isOwner = (req: Viewer, D: Device) => !!req.user && !!D && ownerOf(D)?.id === req.user.id;
export const viewerName = (req: Viewer) => req.user?.username || null;
// Every machine's posts, by the page's ids: one that machines share (an OpenClaw agent's thread, reached from two)
// once, from the machine that has it now.
export function* allPosts(): Generator<PostRef> {
  for (const D of relay.devices.values()) for (const s of Object.values(D.store.state.sessions)) if (!relay.shadowed(D, s.id)) yield { D, local: s.id, s, id: relay.idOf(D, s.id), agent: D.store.state.agents[s.agent] || null };
}
export const agentsById = () => {
  const m = new Map<string, Agent>();
  for (const D of relay.devices.values()) for (const a of Object.values(D.store.state.agents)) if (!relay.shadowed(D, a.id)) m.set(relay.idOf(D, a.id), a);
  return m;
};
// What you set on a post or an agent (archived, hidden, who sees it, its avatar), on every machine that has it, so
// it stays when another of them has it (brick's own agentbook-cli, after hervalm5 reached its gateway). `field`:
// "post" or "agent", the op's field for its id there.
export const markAll = (ref, field, op) => {
  for (const t of relay.twins(ref.D, ref.local)) t.D.store.commit({ ...op, [field]: t.local });
};
export const agentOfPost = (p: PostRef) => (p?.agent ? { D: p.D, local: p.s.agent, a: p.agent, id: relay.idOf(p.D, p.s.agent) } : null);
// The machine a request means (`?machine=`, or a body's `machine`): one of the person's, by name. Without one: their
// first machine that's on (the one they logged in first), else the one seen last, so it doesn't change as they poll.
export function deviceFor(req: Viewer, name?: string | null) {
  const mine = [...relay.devices.values()].filter((D) => isOwner(req, D));
  if (name) return mine.find((D) => D.name === machineName(name)) || null;
  return firstMachine(mine);
}
export const createdOf = (D: Device) => (D.created ??= accounts.deviceById(D.id)?.created || "");
export const firstMachine = (list) => list.filter((D) => relay.online(D)).sort((a, b) => createdOf(a).localeCompare(createdOf(b)))[0] || [...list].sort((a, b) => (b.seen || 0) - (a.seen || 0))[0] || null;

// Whether a thread of a person's is off their lists while Private terminals is on (withoutKeptOff).
export const keptOff = (uid: string, id: string) => !!state.prefs?.[uid]?.private_terminals && state.private_off?.[id] === uid;
