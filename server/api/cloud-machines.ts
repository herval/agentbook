// Cloud machines: the sandboxes agentbook wakes (cloud.ts) and the machines it makes.

import * as boat from "../integrations/connectors/boat.ts";
import * as exe from "../integrations/connectors/exe.ts";
import { MACHINE_KINDS, providerOf } from "../integrations/connectors/machines.ts";
import { SETUP_PATH, exeScript, loginOf } from "../exe-setup.ts";
import { endTickets } from "../cli-bundle.ts";
import { LOG_PATH, repoPath, stepsOf } from "../image-script.ts";
import { PUBLIC_URL } from "../config.ts";
import { machineName, seatNameOk } from "../../plugin/shared/ids.ts";
import { repoKey } from "../../plugin/shared/repos.ts";
import type { Device } from "../relay.ts";
import { accounts, commit, log, relay, state } from "../core/state.ts";
import { fail, ok, readBody, route, str } from "../core/http.ts";
import type { Req, Res } from "../core/http.ts";
import type { PinBody, SignedBody } from "../core/types.ts";
import { deviceFor, ownerOf, viewerName } from "../core/refs.ts";
import { steer } from "../core/commands.ts";
import { cloud, connectors, images, pushLive } from "../core/services.ts";
import { said } from "./cli.ts";
import { enrollMachine } from "./people.ts";
import { pinFor } from "./passkeys.ts";
import { boxEnd } from "./machines.ts";
import { confirmed } from "./images.ts";
import { terminals } from "./terminals.ts";
import { connectorsMine } from "./connectors.ts";
import { unlink } from "./mesh.ts";


export const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const CLAUDE_TOKEN = "CLAUDE_CODE_OAUTH_TOKEN";
// The secrets a machine from an image is asked for: the image's, and Claude Code's token when it signs in with one.
const secretsAsked = (img) => [...new Set([...(img.def.secrets || []), ...(img.def.claude === "token" ? [CLAUDE_TOKEN] : [])])];
// An Update ended on a machine (its image's script, run there by cloud.setup): it says how with its pace. Done, the
// machine is on that version; failed, its page says where the script stopped.
export function setupHeard(D: Device) {
  const link = state.machine_cloud?.[D.id];
  const s = relay.infoOf(D)?.pace?.setup;
  if (!link?.updating || !s || s.v !== link.updating || s.state === "running") return;
  commit({ t: "machine.cloud", device: D.id, patch: s.state === "ok" ? { v: s.v, updating: null, setup_error: null } : { updating: null, setup_error: String(s.error || "Its update failed.").slice(0, 600) } });
  endTickets(`machine ${D.id}`);
  log(`machine: ${D.name}'s update to v${s.v} ${s.state === "ok" ? "is done" : `failed: ${s.error}`}`);
}
// A machine that sets itself up as it starts (made from an image that isn't built, or with a repo its image lacks):
// the server looks at its sandbox's setup every ten seconds until it's done or failed, an hour at most, and then no
// more. What it found is on the machine's page.
const SETTLE_MS = Number(process.env.AGENTBOOK_IMAGE_POLL_MS || 10e3);
const settling = new Set();
async function settleMachine(D: Device) {
  if (settling.has(D.id)) return;
  settling.add(D.id);
  const done = (patch) => {
    commit({ t: "machine.cloud", device: D.id, patch });
    endTickets(`machine ${D.id}`);
    pushLive();
  };
  try {
    for (const end = Date.now() + 3600e3; ; await new Promise((r) => setTimeout(r, SETTLE_MS))) {
      const link = state.machine_cloud?.[D.id];
      // One on exe.dev is settled by settleOnExe.
      if (!link?.setting || link.kind) return;
      const c = connectors.byId(ownerOf(D)?.id, link.connector, "boat");
      if (!c) return done({ setting: false, setup_error: "Its boat connector is gone, off, or has no key, so agentbook can't see how its setup went." });
      if (Date.now() > end) return done({ setting: false, setup_error: "Its setup took more than an hour. Look at it there: its log is ~/.agentbook-build.log." });
      try {
        const s = await boat.sandbox(c.key, link.sandbox);
        if (s.setup === "done" || (!s.setup && s.state === "on")) return done({ setting: false, setup_error: null });
        if (s.setup === "failed") {
          const parts = stepsOf(await boat.readFile(c.key, link.sandbox, LOG_PATH).catch(() => null));
          const at = parts.steps.find((x) => x.state === "failed") || parts.steps.at(-1);
          return done({ setting: false, setup_error: at ? `Its setup stopped at ${at.label}${at.out ? `: ${at.out.split("\n").at(-1).slice(0, 300)}` : ""}` : s.setup_error || "Its setup script failed before it wrote anything." });
        }
      } catch (e) {
        if (!e.later) return done({ setting: false, setup_error: e.message });
      }
    }
  } finally {
    settling.delete(D.id);
  }
}
setTimeout(() => {
  for (const D of relay.devices.values()) if (state.machine_cloud?.[D.id]?.setting && !state.machine_cloud[D.id].kind) settleMachine(D).catch(() => {});
}, 2000).unref();
// Make a cloud machine: a sandbox on your boat account from an image of yours (Basic when none is said), that logs
// itself in to this server as a machine of yours; or a VM on your exe.dev account, that joins your account through
// the relay (makeOnExe). { connector, name, image?, size?, repo?, secrets: { NAME: value }, claude? }.
route("POST", "/api/cloud/machines", async (req, res) => {
  if (!connectorsMine(req, res)) return;
  const b = await readBody<SignedBody & PinBody & { connector?: string; repo?: string; name?: string; image?: string; size?: string; secrets?: Record<string, unknown>; claude?: string }>(req);
  const uid = req.user.id;
  const any = connectors.byId(uid, str(b.connector, 100), MACHINE_KINDS);
  if (any?.kind === "exe") return makeOnExe(req, res, b, any);
  const c = any?.kind === "boat" ? any : null;
  if (!c) return fail(res, 404, "No such boat connector of yours, or it's off.");
  const key = b.repo ? repoKey(str(b.repo, 1000)) : null;
  if (b.repo && !key?.startsWith("github.com/")) return fail(res, 400, "A cloud machine starts with a GitHub repo, as owner/repo.");
  const repo = key ? key.slice("github.com/".length) : null;
  const name = machineName(b.name || (repo ? `boat-${repo.split("/").pop()}` : ""));
  if (!name) return fail(res, 400, "Name the machine.");
  if (accounts.deviceNamed(name)) return fail(res, 409, `There's a machine called ${name} already. Give this one another name.`);
  // Its agentbook-cli runs in a seat of yours there from the start, so it can be shared: a Linux user named as you are.
  if (!seatNameOk(req.user.username)) return fail(res, 409, `@${req.user.username} can't be a Linux user's name, which your seat on the machine needs: lowercase letters, digits, - and _, starting with a letter, and not a name the machine has for itself (user, admin, root).`);
  const seat = { owner: req.user.username, machine: name };
  let img;
  try {
    img = b.image ? images.get(uid, str(b.image, 80)) : images.basic(uid, c.id);
  } catch (e) {
    return fail(res, e.status || 500, e.message);
  }
  if (!img) return fail(res, 404, "No such image of yours.");
  // What the machine starts with is what's on its disk: its newest built version's definition, when there is one, and
  // the draft only when nothing's built (it then installs the draft as it starts). Never the draft's repos, secrets or
  // settings laid over an older snapshot that doesn't have them.
  const built = images.newest(img.id);
  const has = built ? built.def : img.def;
  const size = boat.SIZES.includes(b.size) ? b.size : boat.SIZES.includes(c.settings?.size) && !b.image ? c.settings.size : has.size;
  const asked = secretsAsked({ def: has });
  const values = Object.fromEntries(asked.map((k) => [k, typeof b.secrets?.[k] === "string" ? b.secrets[k] : ""]).filter(([, v]) => v));
  if (!confirmed(req, res, b, "cloud.make", { machine: name, image: img.id })) return;
  const extra = repo && !has.repos.some((r) => r.repo.toLowerCase() === repo) ? [{ repo }] : [];
  const def = { ...has, repos: [...has.repos, ...extra] };
  const made = enrollMachine(req, b, name);
  if (made.error) return fail(res, made.status, made.error);
  // Your passkeys go with its login, in the file root reads as it makes your seat: the machine's helper, which adds
  // people to it, goes by them from before anything of yours runs there.
  const pin = pinFor(req, b);
  const D = relay.devices.get(made.device.id);
  const about = `machine ${D.id}`;
  const envName = `agentbook-${name}`;
  let env = null;
  let box = null;
  try {
    // Not built: it installs everything as it starts. Built: it makes your seat, and clones a repo its image lacks.
    const script = !built ? images.script(def, { uid, about, title: `${name}, from ${img.name}`, git: def.repos.length > 0, seat }).script : images.script({ ...has, repos: extra }, { uid, about, title: extra.length ? `${name}: ${repo}` : name, git: extra.length > 0, only: ["seat", "repos"], seat }).script;
    env = await boat.setEnvironment(c.key, envName, { ...has.env, ...values });
    box = await boat.create(
      c.key,
      { name, size, from: built?.snapshot, script, files: [{ path: ".agentbook-enroll", content: JSON.stringify({ ...made.enroll, codex_tools: has.agents.includes("codex"), ...(pin ? { pin } : {}) }) }], environment: envName, stopIn: 3600, labels: { agentbook: new URL(PUBLIC_URL).host.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 60), "agentbook/machine": name }, org: c.settings?.org, monitoring: false },
      { idempotency: made.device.id },
    );
    commit({ t: "machine.cloud", device: D.id, connector: c.id, sandbox: box.id, made: true, image: img.id, v: built?.v ?? null, size, env, env_name: envName, secrets: Object.keys(values), setting: true });
    settleMachine(D).catch(() => {});
  } catch (e) {
    // Nothing half-made stays: its login here (it never connected, so there's nothing of it to keep), and its
    // environment on boat.
    accounts.revokeDevice(D.id, uid);
    relay.destroy(D.id);
    endTickets(about);
    if (env) boat.dropEnvironment(c.key, env).catch(() => {});
    pushLive();
    return fail(res, e.status && e.status < 500 ? 409 : 502, e.message);
  }
  log(`machine: ${said(name)} is sandbox ${box.id} on @${req.user.username}'s boat, from ${img.id}${built ? ` v${built.v}` : ", unbuilt"}`);
  pushLive();
  ok(res, { machine: name, sandbox: box.id, image: img.id, v: built?.v ?? null, setting: !!state.machine_cloud[D.id].setting, folder: repo ? repoPath(repo) : null, missing: asked.filter((k) => !values[k]) });
});
// A cloud machine agentbook made, with its owner's connector for it: { D, link, c }, or it has answered.
function madeMachine(req: Req, res: Res, name: string) {
  if (!connectorsMine(req, res)) return null;
  const D = deviceFor(req, name);
  if (!D) return void fail(res, 404, "No such machine of yours.");
  const link = state.machine_cloud?.[D.id];
  if (!link?.made) return void fail(res, 409, `${D.name} isn't a machine agentbook made.`);
  const c = connectors.byId(req.user.id, link.connector, MACHINE_KINDS);
  if (!c) return void fail(res, 409, `Its ${providerOf(link.kind)?.name || "boat"} connector is gone, off, or has no key.`);
  return { D, link, c };
}
// What only a machine made on boat has (secrets on its environment, an image to update to).
const boatOnly = (res: Res, m: { D: Device; c: { kind: string } }) => m.c.kind === "boat" || void fail(res, 409, `${m.D.name} runs on ${providerOf(m.c.kind)?.name}, where agentbook keeps no secrets or images for it: set them up on the machine itself.`);
// Set or take away one of its secrets ({ name, value }; no value: taken away). The value goes to boat, on the
// machine's own environment, and is never kept here: only its name is.
route("POST", "/api/machines/:name/cloud/secrets", async (req, res, { params }) => {
  const m = madeMachine(req, res, params.name);
  if (!m || !boatOnly(res, m)) return;
  const b = await readBody<{ name?: string; value?: unknown }>(req);
  const name = str(b.name, 128);
  if (!SECRET_NAME.test(name)) return fail(res, 400, "A secret's name is letters, digits and _, like OPENAI_API_KEY.");
  const value = typeof b.value === "string" && b.value ? b.value.slice(0, 20000) : null;
  try {
    await boat.setSecret(m.c.key, m.link.env, name, value);
  } catch (e) {
    return fail(res, 502, e.message);
  }
  commit({ t: "machine.cloud", device: m.D.id, patch: { secrets: [...new Set([...(m.link.secrets || []).filter((k) => k !== name), ...(value == null ? [] : [name])])] } });
  pushLive();
  ok(res, { secrets: state.machine_cloud[m.D.id].secrets, restart: relay.online(m.D) });
});
// Update it to its image's newest built version: the machine runs that version's script on its own disk, so only
// what's new installs and its work stays. A command of its owner's, signed like any that runs something there.
route("POST", "/api/machines/:name/cloud/update", async (req, res, { params }) => {
  const m = madeMachine(req, res, params.name);
  if (!m || !boatOnly(res, m)) return;
  const img = images.get(req.user.id, m.link.image);
  const built = img && images.newest(img.id);
  if (!built) return fail(res, 409, "Its image has no built version to update to.");
  if (m.link.v != null && m.link.v >= built.v) return fail(res, 409, `${m.D.name} is on v${m.link.v} already, the newest that's built.`);
  if (!relay.online(m.D)) return fail(res, 409, `${m.D.name} is off. Wake it first: an update runs on the machine.`);
  // (Signed, it's the script that was signed that goes: steer sends what the envelope holds.)
  let script;
  try {
    script = images.script(built.def, { uid: req.user.id, about: `machine ${m.D.id}`, title: `${m.D.name}, to ${img.name} v${built.v}`, git: false }).script;
  } catch (e) {
    return fail(res, e.status || 500, e.message);
  }
  await steer(req, res, m.D, "cloud.setup", { script, v: built.v }, { wait: 15e3, after: () => (commit({ t: "machine.cloud", device: m.D.id, patch: { updating: built.v, setup_error: null } }), pushLive()) });
});
// Delete it: its sandbox and its environment on boat, or its VM on exe.dev (which comes off your account too), and its
// login here. Its threads stay, ended.
route("POST", "/api/machines/:name/cloud/delete", async (req, res, { params }) => {
  const m = madeMachine(req, res, params.name);
  if (!m) return;
  const b = await readBody<SignedBody>(req);
  if (!confirmed(req, res, b, "cloud.delete", { machine: m.D.name })) return;
  const p = providerOf(m.c.kind);
  try {
    await p.remove(m.c.key, m.link.sandbox);
  } catch (e) {
    return fail(res, 502, `${p.name} didn't delete its sandbox: ${e.message}`);
  }
  if (m.link.env && m.c.kind === "boat") await boat.dropEnvironment(m.c.key, m.link.env).catch((e) => log(`machine: ${m.D.name}: its environment stays on boat: ${e.message}`));
  if (m.c.kind === "exe") await unlink(m.D.name, req.user.username).catch((e) => log(`machine: ${m.D.name}: not unlinked: ${e.message}`));
  boxEnd(m.D.id);
  commit({ t: "machine.cloud", device: m.D.id });
  cloud.forget(m.D);
  accounts.revokeDevice(m.D.id, req.user.id);
  relay.forget(m.D);
  terminals.forget(m.D.id);
  log(`machine: ${said(m.D.name)} deleted by @${req.user.username}, with its sandbox ${m.link.sandbox}`);
  pushLive();
  ok(res, { deleted: m.D.name });
});

/* ---------- machines on exe.dev ---------- */

// Make a machine on your exe.dev account: a VM named as the machine, set up by a script agentbook starts on it over ssh
// (exe-setup.ts), which installs agentbook and logs it in to your account through the relay. Its machine is here at
// once, off, as yours: when the VM links to this page (server/mesh.ts's deviceHere), it's this one, by its name. Its
// page shows how its setup goes, and the code to say yes to on the relay's page.
async function makeOnExe(req: Req, res: Res, b: SignedBody & { repo?: string; name?: string; claude?: string }, c: { id: string; kind: string; key: string }) {
  const key = b.repo ? repoKey(str(b.repo, 1000)) : null;
  if (b.repo && !key?.startsWith("github.com/")) return fail(res, 400, "A cloud machine starts with a GitHub repo, as owner/repo.");
  const repo = key ? key.slice("github.com/".length) : null;
  const name = machineName(b.name || (repo ? `exe-${repo.split("/").pop()}` : "exe-machine"));
  if (!name || name === "machine") return fail(res, 400, "Name the machine.");
  if (!exe.VM_NAME.test(name)) return fail(res, 400, `${name} can't be an exe.dev VM's name: lowercase letters, digits and -, 63 at most.`);
  if (accounts.deviceNamed(name)) return fail(res, 409, `There's a machine called ${name} already. Give this one another name.`);
  const claude = b.claude === "gateway" ? "gateway" : "signin";
  if (!confirmed(req, res, b, "cloud.make", { machine: name, provider: "exe" })) return;
  const made = enrollMachine(req, {}, name);
  if (made.error) return fail(res, made.status, made.error);
  const D = relay.devices.get(made.device.id);
  try {
    const vm = await exe.create(c.key, { name });
    await exe.start(c.key, vm.id, SETUP_PATH, exeScript({ name, repo, claude }));
    commit({ t: "machine.cloud", device: D.id, connector: c.id, sandbox: vm.id, kind: "exe", made: true, setting: true });
  } catch (e) {
    // Nothing half-made stays here: its machine never connected. A VM exe.dev made stays there, for its person to
    // look at or delete (its name is in the error's log line).
    accounts.revokeDevice(D.id, req.user.id);
    relay.destroy(D.id);
    pushLive();
    log(`machine: ${said(name)} not made on @${req.user.username}'s exe.dev: ${e.message}`);
    return fail(res, e.status && e.status < 500 ? 409 : 502, e.message);
  }
  log(`machine: ${said(name)} is a VM on @${req.user.username}'s exe.dev, setting itself up`);
  settleOnExe(D).catch(() => {});
  pushLive();
  // No folder for a workspace: one starts at /, and the VM's home is its own until it's on. Its clone in ~/dev is
  // there for its agents.
  ok(res, { machine: name, sandbox: name, setting: true, folder: null, missing: [] });
}
// How an exe.dev machine's setup goes, read from its log over ssh every ten seconds until it's on, its setup failed, or
// an hour went by: the code its login waits on goes to its page (`login`), as soon as it's printed.
const settlingOnExe = new Set<string>();
async function settleOnExe(D: Device) {
  if (settlingOnExe.has(D.id)) return;
  settlingOnExe.add(D.id);
  const patch = (p: Record<string, unknown>) => (commit({ t: "machine.cloud", device: D.id, patch: p }), pushLive());
  try {
    for (const end = Date.now() + 3600e3; ; await new Promise((r) => setTimeout(r, SETTLE_MS))) {
      const link = state.machine_cloud?.[D.id];
      if (!link?.setting || link.kind !== "exe") return;
      if (relay.online(D)) return patch({ setting: false, login: null, setup_error: null });
      const c = connectors.byId(ownerOf(D)?.id, link.connector, "exe");
      if (!c) return patch({ setting: false, login: null, setup_error: "Its exe.dev connector is gone, off, or has no key, so agentbook can't see how its setup went." });
      if (Date.now() > end) return patch({ setting: false, login: null, setup_error: `Its setup took more than an hour. Look at it there: ssh ${link.sandbox}.exe.xyz, and ~/${LOG_PATH}` });
      let text: string | null;
      try {
        text = await exe.readFile(c.key, link.sandbox, LOG_PATH);
      } catch (e) {
        if (e.later) continue;
        return patch({ setting: false, login: null, setup_error: e.message });
      }
      const parts = stepsOf(text);
      if (parts.ended === "failed") {
        const at = parts.steps.find((x) => x.state === "failed") || parts.steps.at(-1);
        return patch({ setting: false, login: null, setup_error: at ? `Its setup stopped at ${at.label}${at.out ? `: ${at.out.split("\n").at(-1).slice(0, 300)}` : ""}` : "Its setup failed before it wrote anything." });
      }
      const asked = loginOf(text);
      if ((asked?.code || null) !== (link.login?.code || null)) patch({ login: asked ? { ...asked, at: new Date().toISOString() } : null });
    }
  } finally {
    settlingOnExe.delete(D.id);
  }
}
setTimeout(() => {
  for (const D of relay.devices.values()) if (state.machine_cloud?.[D.id]?.setting && state.machine_cloud[D.id].kind === "exe") settleOnExe(D).catch(() => {});
}, 2000).unref();
// Start its setup again, on the VM it has: after a failure, or a code that ran out before anyone said yes. Everything
// it did already stays done.
route("POST", "/api/machines/:name/cloud/setup", async (req, res, { params }) => {
  const m = madeMachine(req, res, params.name);
  if (!m) return;
  if (m.c.kind !== "exe") return fail(res, 409, `${m.D.name} isn't a machine on exe.dev.`);
  if (relay.online(m.D)) return fail(res, 409, `${m.D.name} is on already.`);
  try {
    await exe.start(m.c.key, m.link.sandbox, SETUP_PATH, exeScript({ name: m.D.name }));
  } catch (e) {
    return fail(res, 502, e.message);
  }
  commit({ t: "machine.cloud", device: m.D.id, patch: { setting: true, setup_error: null, login: null } });
  settleOnExe(m.D).catch(() => {});
  pushLive();
  ok(res, { setting: true });
});

// Take back a command that waits for a machine that's off.
route("POST", "/api/machines/:name/commands/:cid/cancel", (req, res, { params }) => {
  const D = deviceFor(req, params.name);
  if (!D) return fail(res, 404, "No such machine of yours.");
  if (!relay.waiting(D).some((c) => c.cid === params.cid)) return fail(res, 404, "Nothing of yours waits by that id.");
  relay.cancel(D, params.cid) ? ok(res, { cancelled: true }) : fail(res, 409, "It's on its way to its machine.");
});
// Yours.
route("POST", "/api/devices/:id/revoke", async (req, res, { params }) => {
  const D = relay.devices.get(params.id);
  // One linked to this one (linked: server/mesh.ts) is unlinked, on both pages: Disconnect alone would leave this one
  // sending it threads.
  const linked = D && ownerOf(D)?.id === req.user.id ? await unlink(D.name, viewerName(req)) : null;
  if (!accounts.revokeDevice(params.id, req.user.id) && !linked) return fail(res, 404, "No such machine.");
  boxEnd(params.id);
  // Its sandbox is no longer this server's to wake or stop: it stays on boat, as it was.
  if (state.machine_cloud?.[params.id]) {
    commit({ t: "machine.cloud", device: params.id });
    if (D) cloud.forget(D);
  }
  if (D) relay.forget(D);
  terminals.forget(params.id);
  ok(res);
});
