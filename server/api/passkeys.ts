// Passkeys: what you sign commands with.

import crypto from "node:crypto";
import { assertionRefusal, canonical, fingerprint, isKey } from "../../plugin/shared/signed.ts";
import { PAGE_MACHINE_ID } from "../config.ts";
import type { Device } from "../relay.ts";
import { accounts, relay, storage } from "../core/state.ts";
import { PeerTables } from "../../plugin/shared/storage/peers.ts";
import { fail, ok, readBody, route, str } from "../core/http.ts";
import type { Req, Res } from "../core/http.ts";
import type { Answer, PinBody, SignedBody } from "../core/types.ts";
import { deviceFor, viewerName } from "../core/refs.ts";
import { keysOf, linkedHere, needsKeys, signingOf, takesNot } from "../core/commands.ts";

// A page passkeys sign on, as a machine checks it (plugin/cli/signatures.ts): https anywhere, or http at localhost.
export const PAGE_OK = /^(https:\/\/[^/\s]+|http:\/\/localhost(:\d+)?)$/;
// What a machine is to keep of yours: your passkeys' public halves, and the page and site they sign on (the page's
// own address, as it says it). Null when you have none. The machine trusts this once, as it first meets your keys.
export function pinFor(req: Req, b: PinBody) {
  const mine = accounts.passkeys(req.user.id);
  if (!mine.length) return null;
  const host = String(req.headers.host || "").replace(/:\d+$/, "");
  const origin = str(b.origin, 300) || req.headers.origin || "";
  return { keys: mine.map(({ id, alg, spki, name }) => ({ id, alg, spki, ...(name ? { name } : {}) })), origin, rp_id: str(b.rp_id, 255) || host };
}
// Signing for a machine of yours, from its row on your profile or its page: it keeps your passkeys (one that keeps
// none takes them as they come). There's no off: a machine takes what can run something only signed.
route("POST", "/api/machines/:name/signing", async (req, res, { params }) => {
  const D = deviceFor(req, params.name);
  if (!D) return fail(res, 404, "No such machine of yours.");
  const b = await readBody<PinBody & { on?: boolean }>(req);
  const s = signingOf(D);
  // Another machine of yours takes your passkeys on this page by itself, as it's asked to (keys.fetch).
  if (linkedHere(D)) {
    if (s) return ok(res, { signs: true });
    const r = (await relay.command(D, "keys.fetch", {}, { by: viewerName(req), wait: 15e3 })) as Answer;
    return signingOf(D) ? ok(res, { signs: true }) : fail(res, r?.status && !r?.queued ? r.status : 409, takesNot(D.name, storage.use(PeerTables).get(D.name)?.site || null, r));
  }
  if (b.on) {
    if (s) return ok(res, { signs: true });
    const pin = pinFor(req, b);
    if (!pin) return fail(res, 409, "Make a passkey first.");
    const r = (await relay.command(D, "keys.pin", { pin }, { by: viewerName(req), wait: 20e3 })) as Answer;
    if (r?.error && r.status) return fail(res, r.status, r.error);
    return ok(res, { signs: !r?.queued, ...(r?.queued ? { queued: r.queued, waiting: D.name } : {}) });
  }
  if (!s) return ok(res, { signs: false });
  fail(res, 409, `${D.name} takes what can run something only signed with your passkey, and that can't be turned off. Disconnect it to stop it taking anything.`);
});
// Machine reports identify trusted public keys by fingerprint.
const keyView = (k) => ({ id: k.id, alg: k.alg, name: k.name || null, created: k.created, removing: !!k.removing, fingerprint: fingerprint(k.spki) });
const machinesFor = (uid: string) => accounts.devices(uid).map(d => relay.devices.get(d.id)).filter(d => d && (linkedHere(d) || signingOf(d) || needsKeys(d)));
const trustedKeys = (D: Device): string[] => (signingOf(D)?.keys || []).map(k => k.fingerprint);
const keepers = (uid: string) => machinesFor(uid).map(D => ({
  name: D.name, keys: trustedKeys(D), online: relay.online(D), source: linkedHere(D) ? PAGE_MACHINE_ID : "primary",
}));
function approvalInFlight(d: Device, id: string) {
  return relay.waiting(d).some(c => {
    if (c.kind !== "keys.change" && c.kind !== "keys.pin") return false;
    const args = c.args as { change?: { envelope?: { add?: { id: string }[] } }; pin?: { keys?: { id: string }[] } };
    return (args?.change?.envelope?.add || args?.pin?.keys || []).some(k => k.id === id);
  });
}
// Multiple browsers can enroll at the same time. A challenge belongs to one person and can be consumed once.
const passkeyChallenges = new Map<string, { uid: string; expires: number }>();
route("GET", "/api/passkeys", (req, res) => {
  const uid = req.user.id;
  const machines = machinesFor(uid);
  const passkeys = accounts.passkeys(uid, true).filter(k => {
    if (!k.removing || machines.some(d => trustedKeys(d).includes(fingerprint(k.spki)) || approvalInFlight(d, k.id))) return true;
    accounts.removePasskey(uid, k.id);
    return false;
  });
  ok(res, { passkeys: passkeys.map(keyView), machines: keepers(uid) });
});
// Making one: a challenge for the browser, and what it should make.
route("POST", "/api/passkeys/options", (req, res) => {
  const challenge = crypto.randomBytes(32).toString("base64url");
  for (const [id, entry] of passkeyChallenges) if (entry.expires <= Date.now()) passkeyChallenges.delete(id);
  passkeyChallenges.set(challenge, { uid: req.user.id, expires: Date.now() + 5 * 60e3 });
  const u = accounts.byId(req.user.id);
  ok(res, { challenge, user: { id: Buffer.from(req.user.id).toString("base64url"), name: u.username, displayName: u.display_name || u.username }, exclude: keysOf(req.user.id) });
});
// The one the browser made: its public half, kept for the machines to pin. A machine that keeps your keys already
// takes it once one of them signs it in (spread).
route("POST", "/api/passkeys", async (req, res) => {
  const b = await readBody<{ clientDataJSON?: string; id?: string; alg?: number; spki?: string; name?: string }>(req);
  let client = null;
  try {
    client = JSON.parse(Buffer.from(String(b.clientDataJSON || ""), "base64url").toString("utf8"));
  } catch {}
  const want = passkeyChallenges.get(client?.challenge);
  if (!want || want.uid !== req.user.id || want.expires <= Date.now() || client?.type !== "webauthn.create") return fail(res, 400, "That passkey wasn't made for this page just now. Try again.");
  if (req.headers.origin && client.origin !== req.headers.origin) return fail(res, 400, "That passkey was made on another page.");
  passkeyChallenges.delete(client.challenge);
  const key = { id: str(b.id, 1400), alg: Number(b.alg), spki: str(b.spki, 2000), name: str(b.name, 80) || "A passkey" };
  if (!isKey(key)) return fail(res, 400, "agentbook takes passkeys that sign with ES256, Ed25519 or RS256.");
  const existing = accounts.passkeys(req.user.id, true).find(k => k.id === key.id);
  if (existing && (existing.removing || existing.alg !== key.alg || existing.spki !== key.spki)) return fail(res, 409, "This credential ID is already registered. Create a new passkey.");
  if (!accounts.addPasskey(req.user.id, key)) return fail(res, 409, "That passkey is someone else's.");
  const fp = fingerprint(key.spki);
  ok(res, { passkey: keyView({ ...key, created: new Date().toISOString() }), spread: keepers(req.user.id).filter((m) => !m.keys.includes(fp)).map((m) => m.name) });
});
route("POST", "/api/passkeys/:id/rename", async (req, res, { params }) => {
  const { name } = await readBody<{ name?: string }>(req);
  if (typeof name !== "string" || !name.trim() || name.trim().length > 80) return fail(res, 400, "Enter a name of up to 80 characters.");
  if (!accounts.renamePasskey(req.user.id, params.id, name.trim())) return fail(res, 404, "No such passkey of yours.");
  ok(res, { name: name.trim() });
});
// A request is complete for a machine once its gate reports the requested fingerprint change.
type ChangeResult = { sent: string[]; pending: { machine: string; reason: string }[] };
async function deliver(machines: Device[], fp: string, adding: boolean, command: (d: Device) => Promise<Answer>): Promise<ChangeResult> {
  const results = await Promise.all(machines.map(async d => {
    const answer = await command(d).catch((): Answer => ({ error: "Could not reach this machine." }));
    if (answer?.error) return { machine: d.name, reason: answer.error };
    if (answer?.queued) return { machine: d.name, reason: "Queued. Refresh when the machine is back online." };
    if (trustedKeys(d).includes(fp) !== adding) return { machine: d.name, reason: "Waiting for the machine to confirm. Refresh to check." };
    return { machine: d.name, reason: "" };
  }));
  return { sent: results.filter(r => !r.reason).map(r => r.machine), pending: results.filter(r => r.reason) };
}

async function signedChange(req: Req, res: Res, machines: Device[], key: ReturnType<typeof accounts.passkeys>[number], adding: boolean, b: SignedBody & { machine?: string }) {
  const fp = fingerprint(key.spki);
  const { id, alg, spki, name } = key;
  const add = adding ? [{ id, alg, spki, ...(name ? { name } : {}) }] : [];
  const remove = adding ? [] : [id];
  const changes = machines.filter(d => trustedKeys(d).includes(fp) !== adding);
  if (!changes.length) return { sent: machines.map(d => d.name), pending: [] };
  const mine = accounts.passkeys(req.user.id, !adding).filter(k => !k.removing || k.id === id);
  const target = adding && b.machine ? signingOf(changes[0])?.machine : undefined;
  const signers = mine.filter(k => (!adding || k.id !== id) && changes.some(d => trustedKeys(d).includes(fingerprint(k.spki))));
  if (!signers.length) return void fail(res, 409, "No registered passkey can approve this change. Open Settings → Passkeys and recover a key on the machine.");
  if (!b.signed) return void fail(res, 428, "Approve with a passkey the machine already trusts.", {
    sign: { v: 1, kind: "keys.change", ...(target ? { machine: target } : {}), add, remove, at: new Date().toISOString() }, keys: signers.map(k => k.id),
  });
  const { envelope, sig } = b.signed;
  const signer = signers.find(k => k.id === sig?.key);
  if (!signer || envelope?.kind !== "keys.change" || envelope.machine !== target || canonical(envelope.add) !== canonical(add) || canonical(envelope.remove) !== canonical(remove)) {
    return void fail(res, 409, "The signed change does not match this request. Try again.");
  }
  if (!adding) {
    if (envelope.v !== 1 || !Number.isFinite(Date.parse(envelope.at)) || Math.abs(Date.now() - Date.parse(envelope.at)) > 5 * 60e3) return void fail(res, 409, "Removal approval expired. Try again.");
    // With an offline machine the page must authenticate the removal before recording it.
    const valid = changes.some(d => {
      const site = signingOf(d);
      return site?.origin && trustedKeys(d).includes(fingerprint(signer.spki)) && !assertionRefusal(envelope, sig, { keys: [signer], origin: site.origin, rpId: site.rp_id || new URL(site.origin).hostname });
    });
    if (!valid) return void fail(res, 403, "Could not verify the passkey that approved this removal.");
    accounts.markRemoving(req.user.id, id);
  }
  return deliver(changes, fp, adding, async d => {
    if (!trustedKeys(d).includes(fingerprint(signer.spki))) return { error: "Approve with a passkey this machine trusts." };
    // A queued addition could restore a key after its owner removed it on this page.
    if (adding && !relay.online(d)) return { error: "Offline. Retry approval when this machine is back online." };
    return relay.command(d, "keys.change", { change: { envelope, sig } }, { by: viewerName(req), wait: 15e3 });
  });
}
route("POST", "/api/passkeys/:id/spread", async (req, res, { params }) => {
  const b = await readBody<SignedBody & { machine?: string }>(req);
  const key = accounts.passkeys(req.user.id).find(k => k.id === params.id);
  if (!key) return fail(res, 404, "No such passkey of yours.");
  const machines = machinesFor(req.user.id).filter(d => b.machine === undefined || b.machine === d.name);
  if (b.machine !== undefined && !machines.length) return fail(res, 404, "No such machine of yours.");
  const result = await signedChange(req, res, machines, key, true, b);
  if (result) ok(res, result);
});
route("POST", "/api/passkeys/:id/remove", async (req, res, { params }) => {
  const b = await readBody<SignedBody>(req);
  const key = accounts.passkeys(req.user.id, true).find(k => k.id === params.id);
  if (!key) return fail(res, 404, "No such passkey of yours.");
  const fp = fingerprint(key.spki);
  const all = machinesFor(req.user.id);
  const approving = all.filter(d => approvalInFlight(d, key.id));
  if (approving.length) return fail(res, 409, `An approval is still awaiting confirmation on ${approving.map(d => d.name).join(", ")}. Retry removal once it returns.`);
  const machines = all.filter(d => trustedKeys(d).includes(fp));
  const primary = machines.filter(d => !linkedHere(d));
  const alternatives = new Set(accounts.passkeys(req.user.id).filter(k => k.id !== key.id).map(k => fingerprint(k.spki)));
  const alone = primary.filter(d => !trustedKeys(d).some(f => alternatives.has(f))).map(d => d.name);
  if (alone.length) return fail(res, 409, `${alone.join(", ")} ${alone.length === 1 ? "keeps" : "keep"} only this passkey. Approve another passkey there first.`);
  if (!primary.length) accounts.markRemoving(req.user.id, key.id);
  const result = await signedChange(req, res, primary, key, false, b);
  if (!result) return;
  // A linked page may take access away even when the person lost the old passkey.
  const linked = await deliver(machines.filter(linkedHere), fp, false, d => relay.command(d, "keys.vouch", { forget: [key.id] }, { by: viewerName(req), wait: 15e3 }));
  const pending = [...result.pending, ...linked.pending];
  if (!pending.length) accounts.removePasskey(req.user.id, key.id);
  ok(res, { removed: !pending.length, sent: [...result.sent, ...linked.sent], pending });
});
