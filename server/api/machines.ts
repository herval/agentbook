// Your machines' pages and settings, and the people on a shared one.

import * as boat from "../integrations/connectors/boat.ts";
import { MACHINE_KINDS, providerOf } from "../integrations/connectors/machines.ts";
import { isTalkId } from "../../plugin/shared/talks.ts";
import { cliLatest } from "../config.ts";
import { newestOf } from "../../plugin/shared/versions.ts";
import { machineName, seatNameOk } from "../../plugin/shared/ids.ts";
import type { Device } from "../relay.ts";
import type { Box, BoxMember } from "../../plugin/shared/types.ts";
import { accounts, commit, log, relay, state } from "../core/state.ts";
import { fail, ok, readBody, route, send, str } from "../core/http.ts";
import type { Viewer } from "../core/http.ts";
import type { Answer, PinBody, SignedBody } from "../core/types.ts";
import { createdOf, deviceFor, isOwner, ownerOf, postRef, viewerName } from "../core/refs.ts";
import { readOf, signingOf, steer } from "../core/commands.ts";
import { cloud, connectors, pushLive } from "../core/services.ts";
import { cloudView } from "./views.ts";
import { said } from "./cli.ts";
import { enrollMachine } from "./people.ts";
import { linkedOf } from "./mesh.ts";
import { SECRET_NAME } from "./cloud-machines.ts";
import { terminals } from "./terminals.ts";
import { connectorsMine } from "./connectors.ts";

// Someone's machines, with whether each is on now. `linked`: one linked to this page's own (linked: server/mesh.ts).
export const devicesOf = (uid: string) =>
  accounts.devices(uid).map((d) => {
    const D = relay.devices.get(d.id);
    // Whether it signs, once it said (its gate's summary); null for one that hasn't connected yet.
    const g = D && relay.infoOf(D)?.machine?.gate;
    const linked = linkedOf({ user: { id: uid } } as Viewer, d.name);
    return { ...d, online: !!D && relay.online(D), signs: g ? !!signingOf(D) : null, server_here: g?.server_here === true, ...(linked ? { linked } : {}) };
  });
route("GET", "/api/devices", (req, res) => ok(res, { devices: devicesOf(req.user.id) }));
// What a machine of yours lets this server make it do (its gate, which only the machine changes), and what its gate
// did with the latest commands: ran them, refused them and why, asked there first.
route("GET", "/api/machines/:name/gate", (req, res, { params }) => {
  const D = deviceFor(req, params.name);
  if (!D) return fail(res, 404, "No such machine of yours.");
  ok(res, { machine: D.name, online: relay.online(D), gate: relay.infoOf(D).machine?.gate || null, audit: relay.audits(D, 100), waiting: relay.waiting(D) });
});
// A machine of yours, for its page: whether it's on, its agentbook-cli, what it shares, what waits for it, and
// what its gate did with the latest commands.
route("GET", "/api/machines/:name", (req, res, { params }) => {
  const D = deviceFor(req, params.name);
  if (!D) return fail(res, 404, "No such machine of yours.");
  const m = relay.infoOf(D).machine || {};
  const st = D.store.state;
  ok(res, {
    name: D.name,
    online: relay.online(D),
    seen: D.seen ? new Date(D.seen).toISOString() : accounts.deviceById(D.id)?.last_seen || null,
    since: createdOf(D) || null,
    cli: m.cli || null,
    // Whether it updates itself and how that stands, as it says, and the newest version this server tells machines of.
    update: m.update || null,
    latest: cliLatest(),
    os: m.os || null,
    home: m.home || null,
    clone_dir: m.clone_dir || null,
    drivers: m.drivers || {},
    gate: m.gate || null,
    // Its agents' past, for the welcome card (plugin/cli/history.ts).
    history: m.history || null,
    posts: Object.keys(st.sessions).length,
    agents: Object.keys(st.agents).length,
    waiting: relay.waiting(D).map((c) => ({ cid: c.cid, kind: c.kind, at: c.at, expires: c.expires, post: typeof c.args.post === "string" && c.args.post ? relay.idOf(D, c.args.post) : null, text: c.args.text || c.args.prompt || null })),
    audit: relay.audits(D, 100),
    // The cloud sandbox it runs in, if its owner said (cloud.ts), and their connectors that run machines (boat,
    // exe.dev), to link one with.
    cloud: cloudView(D) && { ...cloudView(D), github: cloudLink(D).github !== false, github_connected: !!connectors.keyFor(req.user.id, "github") },
    boat: connectors.ofKind(req.user.id, MACHINE_KINDS),
    // A shared machine: whether it's set up to be (its agentbook-cli runs in a seat, with the helper), and its people.
    seat: m.seat || null,
    shares: !!m.shares,
    // Your own secrets on a seat: their names, as its agentbook-cli says. Their values are in your home there.
    secrets: Array.isArray(m.secrets) ? m.secrets : [],
    people: state.boxes?.[D.id] ? boxPeople(state.boxes[D.id]) : [],
  });
});
// Whether a newer agentbook is out for a machine of yours, and where it stands: it asks main in the repo it was
// installed from (plugin/cli/update.ts), unless it did in the last `within` ms (the Updates card, as it opens), or
// now (Check now, within=0).
route("GET", "/api/machines/:name/update", async (req, res, { params, query }) => {
  const D = deviceFor(req, params.name);
  if (!D) return fail(res, 404, "No such machine of yours.");
  const within = query.has("within") ? Number(query.get("within")) : NaN;
  await readOf(res, D, "read.update", Number.isFinite(within) && within >= 0 ? { within } : {});
});
// Update a machine's agentbook-cli now, to the newest there is: this server's word (cli-latest), or main's, as the
// machine last found it. Its owner's command, signed like any that runs something there. Only the version goes: the
// machine pulls main from the repo it was cloned from itself. `auto`: and it updates by itself from now on.
route("POST", "/api/machines/:name/update", async (req, res, { params }) => {
  const D = deviceFor(req, params.name);
  if (!D) return fail(res, 404, "No such machine of yours.");
  const said = relay.infoOf(D).machine?.update as { state?: string; to?: string } | undefined;
  const to = newestOf(cliLatest(), said?.state === "behind" || said?.state === "failed" ? said.to : null);
  if (!to) return fail(res, 409, `${D.name} hasn't heard of a newer agentbook.`);
  if (!relay.online(D)) return fail(res, 409, `${D.name} is off: it updates once it's back on.`);
  const b = await readBody<{ auto?: boolean }>(req);
  await steer(req, res, D, "cli.update", { to, ...(b?.auto === true ? { auto: true } : {}) }, { wait: 15e3 });
});
// A boat or exe.dev connector's sandboxes (VMs), to pick the one a machine of yours runs in.
route("GET", "/api/machines/:name/cloud/sandboxes", async (req, res, { params, query }) => {
  if (!connectorsMine(req, res)) return;
  const D = deviceFor(req, params.name);
  if (!D) return fail(res, 404, "No such machine of yours.");
  const c = connectors.byId(req.user.id, query.get("connector") || "", MACHINE_KINDS);
  if (!c) return fail(res, 404, "No such connector of yours that runs machines, or it's off.");
  try {
    ok(res, { sandboxes: await providerOf(c.kind).sandboxes(c.key) });
  } catch (e) {
    fail(res, 502, e.message);
  }
});
// What a cloud machine of yours used this month, at boat's list price, and what's left in the wallet that pays for
// it. Asked of boat when its page is opened, never kept.
route("GET", "/api/machines/:name/cloud/usage", async (req, res, { params }) => {
  if (!connectorsMine(req, res)) return;
  const D = deviceFor(req, params.name);
  if (!D) return fail(res, 404, "No such machine of yours.");
  const link = state.machine_cloud?.[D.id];
  if (!link) return fail(res, 409, `${D.name} isn't linked to a sandbox.`);
  // exe.dev bills a pool of CPU and memory by the month, not machines by the hour: it has nothing to show here.
  if (link.kind && link.kind !== "boat") return ok(res, { usage: null, wallet: null });
  const c = connectors.byId(req.user.id, link.connector, "boat");
  if (!c) return fail(res, 404, "Its boat connector is gone, off, or has no key.");
  const now = new Date();
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  try {
    // The wallet takes account.read, which a key that only wakes may not have: the usage still shows.
    const [used, wallet] = await Promise.all([boat.usage(c.key, link.sandbox, month), boat.wallet(c.key, c.settings.org).catch(() => null)]);
    ok(res, { usage: { ...used, since: month }, wallet });
  } catch (e) {
    fail(res, 502, e.message);
  }
});
// Say which sandbox a machine of yours runs in (its provider checks it's one the connector's key reaches), or, with
// none, that it runs in none.
route("POST", "/api/machines/:name/cloud", async (req, res, { params }) => {
  if (!connectorsMine(req, res)) return;
  const D = deviceFor(req, params.name);
  if (!D) return fail(res, 404, "No such machine of yours.");
  const b = await readBody<{ sandbox?: string; connector?: string }>(req);
  const sandbox = b.sandbox ? str(b.sandbox, 40).trim() : "";
  if (!sandbox) {
    commit({ t: "machine.cloud", device: D.id });
    cloud.forget(D);
    relay.nudge(D);
    return ok(res, { cloud: null });
  }
  const connector = str(b.connector, 100);
  const c = connectors.byId(req.user.id, connector, MACHINE_KINDS);
  if (!c) return fail(res, 404, "No such connector of yours that runs machines, or it's off.");
  const p = providerOf(c.kind);
  if (!p.idOk(sandbox)) return fail(res, 400, p.idHint);
  const other = [...relay.devices.values()].find((x) => x.id !== D.id && state.machine_cloud?.[x.id]?.sandbox === sandbox && isOwner(req, x));
  if (other) return fail(res, 409, `${other.name} is linked to that sandbox already.`);
  try {
    await p.sandbox(c.key, sandbox);
  } catch (e) {
    return fail(res, 400, e.message);
  }
  commit({ t: "machine.cloud", device: D.id, connector, sandbox, kind: c.kind });
  cloud.forget(D);
  relay.nudge(D); // its git hears at once that it signs in to GitHub as its owner (gitGithub)
  // Linked while things wait for it: that's what it was linked for.
  if (!relay.online(D) && relay.waiting(D).length) cloud.held(D);
  ok(res, { cloud: cloud.view(D) });
});
// Whether git on a cloud machine of yours signs in to GitHub as you (gitGithub). It hears at its next poll.
route("POST", "/api/machines/:name/cloud/github", async (req, res, { params }) => {
  if (!connectorsMine(req, res)) return;
  const D = deviceFor(req, params.name);
  if (!D) return fail(res, 404, "No such machine of yours.");
  if (!state.machine_cloud?.[D.id]) return fail(res, 409, `${D.name} isn't linked to a sandbox.`);
  commit({ t: "machine.cloud", device: D.id, github: !!(await readBody<{ on?: boolean }>(req)).on });
  relay.nudge(D);
  ok(res, { github: state.machine_cloud[D.id].github !== false });
});
// Wake a machine of yours that's off, in its sandbox, without sending it anything.
route("POST", "/api/machines/:name/wake", async (req, res, { params }) => {
  if (!connectorsMine(req, res)) return;
  const D = deviceFor(req, params.name);
  if (!D) return fail(res, 404, "No such machine of yours.");
  const r = await cloud.wake(D, { force: true });
  if (r.error) return fail(res, 409, r.error);
  ok(res, { ...r, cloud: cloudView(D) });
});
/* ---------- shared machines: the people on one ---------- */

// A shared machine is its owner's machine (the box, by its device's id) and, for each person the owner added, a seat
// there with that person's own agentbook-cli, which is a machine of theirs here. One page lists its people; anyone's
// message wakes it, on its owner's boat account; and the people on it see the threads that run there, unless one
// was made Private.
// The box a machine is part of: { box (its record), host (the owner's machine), mine (this machine is the host) }.
export function boxOf(D: Device) {
  if (!D) return null;
  const own = state.boxes?.[D.id];
  if (own) return { box: own, host: D, mine: true };
  for (const b of Object.values(state.boxes || {})) if (Object.values(b.members).some((m) => m.device === D.id)) return relay.devices.get(b.id) ? { box: b, host: relay.devices.get(b.id), mine: false } : null;
  return null;
}
// Every machine that's one box with D: its owner's, and each member's seat that's logged in.
export const boxMates = (D: Device) => {
  const b = boxOf(D);
  return b ? [b.host, ...Object.values(b.box.members).map((m) => m.device && relay.devices.get(m.device)).filter(Boolean)] : [D];
};
// The sandbox a machine runs in: its own link, or, for a member's seat, the shared machine's.
export const cloudLink = (D: Device) => state.machine_cloud?.[D.id] || (boxOf(D) && !boxOf(D).mine ? state.machine_cloud?.[boxOf(D).host.id] : null) || null;
// Whose boat account it's on: its owner's, and for a member's seat, the shared machine's owner's.
export const cloudPayer = (D: Device) => (state.machine_cloud?.[D.id] ? ownerOf(D) : ownerOf(boxOf(D)?.host || D));
const onBox = (b, uid: string) => !!uid && (b.owner === uid || b.members[uid]?.state === "joined");
// A thread on a shared machine, for someone else who's on it: seen, unless it was made Private.
export function boxShare(uid: string, id: string) {
  if (!uid || isTalkId(id) || !Object.keys(state.boxes || {}).length) return false;
  const p = postRef(id);
  const b = p && boxOf(p.D);
  return !!b && onBox(b.box, uid) && ownerOf(p.D)?.id !== uid && p.s.visibility !== "private";
}
// Whether someone's seat is made on a shared machine: it was when they were added, or the machine says it has it since
// (an add that waited for a machine that was off makes it when the machine is next on).
// What the machine last said counts only while it's on: off, its list may be from before a seat was removed.
const seatedOn = (b: { id?: string }, m: BoxMember) => {
  const host = relay.devices.get(b.id);
  return !!m.seated || !!(host && relay.online(host) && relay.infoOf(host).machine?.seats?.includes(m.user));
};
const boxPeople = (b: Pick<Box, "members"> & { id?: string }) => Object.entries(b.members).map(([uid, m]) => ({ user: m.user, state: m.state, seated: seatedOn(b, m), machine: (m.device && relay.devices.get(m.device)?.name) || null, online: !!(m.device && relay.devices.get(m.device) && relay.online(relay.devices.get(m.device))), at: m.at, mine_uid: uid })).map(({ mine_uid, ...x }) => x);
// The machines shared with a person, for their page: the ones they're invited to, and the ones they're on.
export const boxesFor = (uid: string) =>
  Object.values(state.boxes || {})
    .filter((b) => b.members[uid] && relay.devices.get(b.id))
    .map((b) => ({ id: b.id, machine: relay.devices.get(b.id).name, owner: accounts.byId(b.owner)?.username || null, state: b.members[uid].state, seated: seatedOn(b, b.members[uid]), seat: (b.members[uid].device && relay.devices.get(b.members[uid].device)?.name) || null }));
// The owner adds someone ({ user }), or takes them off ({ user, remove: true }). An add is signed by the owner's
// passkey: unsigned, it's answered with what to sign, and the machine's root helper checks it, not this server.
route("POST", "/api/machines/:name/people", async (req, res, { params }) => {
  const D = deviceFor(req, params.name);
  if (!D) return fail(res, 404, "No such machine of yours.");
  const b = await readBody<SignedBody & { user?: string; remove?: boolean }>(req);
  const them = accounts.byUsername(str(b.user, 60).replace(/^@/, "").trim());
  if (!them || them.deleted || them.disabled) return fail(res, 404, "Nobody here has that username.");
  if (them.id === req.user.id) return fail(res, 400, "That's you: it's your machine already.");
  const box = state.boxes?.[D.id];
  if (b.remove) {
    const m = box?.members[them.id];
    if (!m) return fail(res, 404, `@${them.username} isn't on ${D.name}.`);
    // Their seat goes when the machine hears (it waits while the machine's off); their login for it goes now.
    const r = (await relay.command(D, "members.change", { change: { envelope: { v: 1, kind: "members.change", machine: D.name, user: them.username, remove: true, at: new Date().toISOString() } } }, { by: viewerName(req), wait: 20e3 })) as Answer;
    if (r?.error && r.status && !/isn't shared/.test(r.error)) return fail(res, r.status, r.error);
    boxDrop(D.id, them.id);
    log(`machine: @${them.username} taken off ${said(D.name)} by @${req.user.username}`);
    return ok(res, { people: boxPeople(state.boxes?.[D.id] || { members: {} }), ...(r?.queued ? { queued: true } : {}) });
  }
  if (!relay.infoOf(D).machine?.shares) return fail(res, 409, `${D.name} isn't set up to be shared. On it, as root: agentbook-cli seat share ${relay.infoOf(D).machine?.seat || "<your seat>"}. That takes a Linux machine where your agentbook-cli runs in a seat.`);
  if (!seatNameOk(them.username)) return fail(res, 400, `@${them.username} can't be a Linux user's name, which their seat needs: lowercase letters, digits, - and _, and not a name the machine has for itself.`);
  if (box?.members[them.id]) return fail(res, 409, `@${them.username} is on ${D.name} already.`);
  const keys = accounts.passkeys(req.user.id);
  if (!keys.length) return fail(res, 409, "Make a passkey first: adding someone to a machine is signed with it.");
  const e = b.signed?.envelope;
  if (!e || !b.signed.sig) return send(res, 428, { error: `Adding someone to ${D.name} is signed with your passkey.`, sign: { v: 1, kind: "members.change", machine: D.name, user: them.username, at: new Date().toISOString() }, keys: keys.map((k) => k.id) });
  if (e.kind !== "members.change" || e.machine !== D.name || e.user !== them.username || e.remove) return fail(res, 400, "What your passkey signed isn't this.");
  const r = (await relay.command(D, "members.change", { change: { envelope: e, sig: b.signed.sig } }, { by: viewerName(req), wait: 30e3 })) as Answer;
  if (r?.error && r.status) return fail(res, r.status, r.error);
  commit({ t: "box.member", box: D.id, owner: req.user.id, member: them.id, user: them.username, state: "invited", seated: !r?.queued });
  log(`machine: @${them.username} added to ${said(D.name)} by @${req.user.username}${r?.queued ? ", once it's on" : ""}`);
  pushLive();
  ok(res, { people: boxPeople(state.boxes[D.id]), ...(r?.queued ? { queued: true } : {}) });
});
// A shared machine goes (deleted, disconnected): everyone's off it, and their seats' logins here go.
export function boxEnd(boxId) {
  for (const uid of Object.keys(state.boxes?.[boxId]?.members || {})) boxDrop(boxId, uid);
  if (state.boxes?.[boxId]) commit({ t: "box.remove", box: boxId });
}
// One of your own secrets on a seat of yours: set ({ name, value }) or taken away ({ name }). It goes to your own
// agentbook-cli there, signed like anything that changes what runs, and is kept in your home on that machine: this
// server passes it on from memory and keeps nothing of it.
route("POST", "/api/machines/:name/secrets", async (req, res, { params }) => {
  const D = deviceFor(req, params.name);
  if (!D) return fail(res, 404, "No such machine of yours.");
  if (!relay.infoOf(D).machine?.seat) return fail(res, 409, `${D.name} isn't a seat on a shared machine. On a machine of your own, set what its sessions need in its own shell.`);
  const b = await readBody<{ name?: string; value?: unknown }>(req);
  const name = str(b.name, 128).trim();
  if (!SECRET_NAME.test(name)) return fail(res, 400, "A secret's name is letters, digits and _, like OPENAI_API_KEY.");
  await steer(req, res, D, "seat.secret", { name, ...(typeof b.value === "string" && b.value ? { value: b.value.slice(0, 20000) } : {}) }, { wait: 15e3 });
});
// Someone's off a box: their seat's login here goes with it.
function boxDrop(boxId, uid: string) {
  const m = state.boxes?.[boxId]?.members[uid];
  if (!m) return;
  const seat = m.device && relay.devices.get(m.device);
  if (m.device) accounts.revokeDevice(m.device, uid);
  if (seat) {
    relay.forget(seat);
    terminals.forget(seat.id);
  }
  commit({ t: "box.member", box: boxId, member: uid, remove: true });
  pushLive();
}
// Someone invited joins: this server makes their seat's login (a machine of theirs, with their passkeys), and the
// shared machine's helper puts it in their seat's home, where their own agentbook-cli takes it.
route("POST", "/api/boxes/:id/join", async (req, res, { params }) => {
  const box = state.boxes?.[params.id];
  const m = box?.members[req.user.id];
  const host = box && relay.devices.get(box.id);
  if (!m || !host) return fail(res, 404, "No machine was shared with you by that id.");
  if (m.state === "joined") return fail(res, 409, `You're on ${host.name} already.`);
  if (!relay.online(host)) return fail(res, 409, `${host.name} is off. Join once it's on: its owner, @${accounts.byId(box.owner)?.username}, can wake it.`);
  const b = await readBody<PinBody>(req);
  const name = machineName(`${host.name}-${req.user.username}`);
  if (accounts.deviceNamed(name)) return fail(res, 409, `There's a machine called ${name} already. Disconnect it first.`);
  const made = enrollMachine(req, b, name);
  if (made.error) return fail(res, made.status, made.error);
  const r = (await relay.command(host, "members.enroll", { user: req.user.username, enroll: { name: made.enroll.name, poll: made.enroll.poll } }, { by: accounts.byId(box.owner)?.username, wait: 30e3 })) as Answer;
  if (!r || r.error || r.queued) {
    accounts.revokeDevice(made.device.id, req.user.id);
    relay.destroy(made.device.id);
    return fail(res, 409, r?.error || `${host.name} didn't take your login. Try again in a moment.`);
  }
  commit({ t: "box.member", box: box.id, member: req.user.id, user: req.user.username, state: "joined", seated: true, device: made.device.id });
  log(`machine: @${req.user.username} joined ${said(host.name)}, as ${name}`);
  pushLive();
  ok(res, { machine: name, on: host.name });
});
// Someone leaves a machine shared with them (or turns the invitation down).
route("POST", "/api/boxes/:id/leave", async (req, res, { params }) => {
  const box = state.boxes?.[params.id];
  const host = box && relay.devices.get(box.id);
  if (!box?.members[req.user.id] || !host) return fail(res, 404, "No machine was shared with you by that id.");
  relay.command(host, "members.change", { change: { envelope: { v: 1, kind: "members.change", machine: host.name, user: req.user.username, remove: true, at: new Date().toISOString() } } }, { by: accounts.byId(box.owner)?.username, wait: 0 });
  boxDrop(box.id, req.user.id);
  log(`machine: @${req.user.username} left ${said(host.name)}`);
  ok(res, { left: host.name });
});
