// Commands to a machine and reads of what it has: signed with its owner's passkey when it says they must be.

import crypto from "node:crypto";
import { envelope, fingerprint, needsSignature, SIGNED_KINDS } from "../../plugin/shared/signed.ts";
import type { Device } from "../relay.ts";
import type { PasskeySignature } from "../../plugin/shared/types.ts";
import { accounts, relay, storage } from "./state.ts";
import { PUBLIC_URL } from "../config.ts";
import { PeerTables } from "../../plugin/shared/storage/peers.ts";
import { fail, ok, readBody } from "./http.ts";
import type { Req, Res, Viewer } from "./http.ts";
import type { Answer, Envelope, ReadAnswer, SignedBody } from "./types.ts";
import { isOwner, viewerName } from "./refs.ts";

// This page's address, as passkeys sign on it for another machine of yours.
export const PAGE_ORIGIN = new URL(PUBLIC_URL).origin;
// Another machine of its person's, linked to this one (linked: server/mesh.ts): it checks what comes from this page as
// from elsewhere, against the keys it took for this page when you OK'd it on that machine's own page (keys.vouch).
export const linkedHere = (D: Device) => !!storage.use(PeerTables).get(D.name);
// A machine of yours that keeps your passkeys says so in its gate's summary: its id for what's signed for it, the
// page its keys sign on, and the kinds it takes only signed. Null for one that keeps none. Another machine of yours
// linked to this one: the keys it took for this page, or null until it took any.
export const signingOf = (D: Device) => {
  const s = relay.infoOf(D)?.machine?.gate?.signed;
  if (!s || typeof s.machine !== "string") return null;
  if (linkedHere(D)) {
    const site = Array.isArray(s.sites) ? s.sites.find((x) => x?.origin === PAGE_ORIGIN) : null;
    return site ? { ...s, origin: site.origin, keys: site.keys } : null;
  }
  return Array.isArray(s.keys) && s.keys.length ? s : null;
};
// A machine whose server is elsewhere that keeps no passkeys yet (connected before signing was a must, or its keys
// taken off on it): its gate says so, and takes nothing that can run something until it keeps its owner's. One whose
// server is itself (agentbook up) takes commands unsigned, as does an agentbook-cli from before it said either way.
export const needsKeys = (D: Device) => !signingOf(D) && relay.infoOf(D)?.machine?.gate?.server_here === false;
// The passkeys that may sign for a person, for the page to offer (and only those).
export const keysOf = (uid: string) => accounts.passkeys(uid).map((k) => k.id);
// How long a browser's key its passkey signed may sign for D, in hours, when D takes one now:
// 0 when the passkey signs it itself, as D takes no
// browser's key, or is off (what waits for it is checked once it's back, maybe after the browser's key ran out).
const sessionsOf = (D: Device) => {
  const h = signingOf(D)?.sessions;
  return relay.online(D) && Number.isFinite(h) && h > 0 ? Math.min(h, 24) : 0;
};
// What a 428 tells the page to sign for D, and with what.
export function toSignFor(req: Viewer, D: Device, need: Envelope) {
  const trusted = (signingOf(D)?.keys || []).map(k => k.fingerprint);
  const keys = isOwner(req, D) ? accounts.passkeys(req.user.id).filter(k => trusted.includes(fingerprint(k.spki))).map(k => k.id) : keysOf(req.user.id);
  return { sign: need, keys, ...(sessionsOf(D) ? { session: sessionsOf(D) } : {}) };
}
// A command for D as its owner's passkey should sign it, or null when D takes it unsigned.
export function toSign(D: Device, kind: string, args: Record<string, unknown>, by: string | null, wait: number): Envelope | null {
  const s = signingOf(D);
  if (!s || !needsSignature({ kind, args }, Array.isArray(s.kinds) ? s.kinds : SIGNED_KINDS)) return null;
  const fitted = relay.fit(D, kind, args);
  args = ("args" in fitted && fitted.args) || args; // signed as it'll take it: one it can't is refused where it's sent
  const now = Date.now();
  return { v: 1, machine: s.machine, cid: `s${crypto.randomBytes(12).toString("base64url")}`, kind, args, by, at: new Date(now).toISOString(), expires: new Date(now + relay.lifetimeOf(kind, wait)).toISOString() };
}
// The signed command a request carries for D, checked for what it says (D checks the signature itself): its
// { envelope, sig }, or { error }.
export function signedFrom(body: SignedBody, D: Device, kind: string | null, by: string | null): { envelope: Envelope; sig: PasskeySignature } | { error: string } {
  const x = body?.signed;
  const e = x?.envelope;
  const s = signingOf(D);
  if (!e || typeof e !== "object" || !x.sig || typeof x.sig !== "object") return { error: "That isn't a signed command." };
  if (!s || e.machine !== s.machine) return { error: `That's signed for another machine than ${D.name}.` };
  if (e.v !== 1 || (kind && e.kind !== kind)) return { error: "That's signed for something else." };
  if (e.by !== by) return { error: "That's signed as someone else." };
  if (typeof e.cid !== "string" || !/^s[\w-]{8,40}$/.test(e.cid)) return { error: "That signed command has no id of its own." };
  if (!(Date.parse(e.expires) > Date.now()) || !(Date.parse(e.expires) - Date.parse(e.at) <= relay.lifetimeOf(e.kind) + 5 * 60e3)) return { error: "That signed command has expired. Try again." };
  return { envelope: envelope(e), sig: x.sig };
}
// Why a linked machine doesn't take what you sign on this page yet, from its answer to keys.fetch.
export function takesNot(name: string, site: string | null, r: Answer | null): string {
  if (r?.queued) return `${name} is off: try again once it's back.`;
  // An agentbook from before keys.fetch takes this page's only as you Sign once on its own page.
  if (/isn't a command/.test(String(r?.error))) return `${name} runs an older agentbook: update it (git pull there), or open its page${site ? ` (${site})` : ""} and press Sign once on this machine's row in Machines.`;
  return r?.error || `${name} hasn't taken your passkeys on this page yet: try again in a moment.`;
}
// Before steering D with what needs its owner's passkey: null when D takes it unsigned (send it as before), the
// signed command to send, or false once it answered itself, with 428 and what to sign (the page signs it and sends
// the same request again, with it) or why the signature it came with won't do.
export async function signedOr428(req: Req, res: Res, D: Device, kind: string, args: Record<string, unknown>, { wait = 20e3 } = {}) {
  const by = viewerName(req);
  const fitted = relay.fit(D, kind, args);
  if ("error" in fitted) {
    fail(res, 426, fitted.error);
    return false;
  }
  let need = toSign(D, kind, args, by, wait);
  // Another machine of yours takes your passkeys on this page by itself (keys.fetch, plugin/cli/page-keys.ts), as it
  // links or as it's asked here: then it takes what they sign here. Its answer comes after its gate's keys reach this
  // page, which toSign goes by.
  const row = !need && linkedHere(D) && needsSignature({ kind, args }, SIGNED_KINDS) ? storage.use(PeerTables).get(D.name) : null;
  if (row) {
    const r = (await relay.command(D, "keys.fetch", {}, { by, wait: 15e3 })) as Answer;
    need = toSign(D, kind, args, by, wait);
    if (!need) {
      fail(res, r?.queued ? 409 : r?.status || 409, takesNot(D.name, row.site, r), keysOf(req.user.id).length ? {} : { needs_passkey: true });
      return false;
    }
  }
  // One whose server is elsewhere that keeps none of your keys yet takes it from nobody (its gate refuses it).
  if (!need && needsKeys(D) && needsSignature({ kind, args }, SIGNED_KINDS)) {
    fail(res, 409, `${D.name} takes this only signed with your passkey, and keeps none of yours yet: turn on Signing for it in Machines, on your profile.`, { needs_keys: D.name });
    return false;
  }
  if (!need) return null;
  const b = await readBody<SignedBody>(req).catch((): SignedBody => ({}));
  if (!b?.signed) {
    fail(res, 428, `${D.name} takes this only signed with your passkey.`, toSignFor(req, D, need));
    return false;
  }
  const signed = signedFrom(b, D, kind, by);
  if ("error" in signed) {
    fail(res, 400, signed.error);
    return false;
  }
  return signed;
}

// A machine's answer to a command for the page: what it said, or that it waits for the machine. One that needs its
// owner's passkey goes signed (signedOr428).
// `after`: what to do once it went, or waits for its machine, with what the page is answered.
// `sending`: what to keep before it goes, with the args it goes with. A signed one goes with the args of the request
// that was asked to sign it (its launch id, say), not this request's, so what's kept by them is kept here.
export async function steer(req: Req, res: Res, D: Device, kind: string, args: Record<string, unknown>, { wait = 20e3, done = (r: Answer): object => r, after = null, sending = null }: { wait?: number; done?: (r: Answer) => object; after?: ((out: object) => void) | null; sending?: ((args: Record<string, unknown>) => void) | null } = {}) {
  const inactive = relay.startError(D, kind, args);
  if (inactive) return fail(res, inactive.status, inactive.error);
  const signed = await signedOr428(req, res, D, kind, args, { wait });
  if (signed === false) return;
  if (signed) args = signed.envelope.args;
  sending?.(args);
  const r = (await relay.command(D, kind, args, { by: viewerName(req), wait, signed })) as Answer;
  // A start that waits keeps its id, so its task follows it, and it shows on the feed meanwhile.
  if (r?.queued) {
    const out = { ok: true, queued: r.queued, waiting: D.name, offline: !!r.offline, ...(typeof args.lid === "string" && args.lid ? { lid: relay.idOf(D, args.lid) } : {}) };
    after?.(out);
    return ok(res, out);
  }
  // A failure says its status; an answer can carry an error that isn't one (a terminal that couldn't open).
  if (r?.error && r.status) return fail(res, r.status, r.error, { ...(r.cmd ? { cmd: r.cmd } : {}), ...(r.force ? { force: true } : {}) });
  const out = { ok: true, ...done(r || {}) };
  after?.(out);
  ok(res, out);
}

// Check before a start's bookkeeping or signature request. The relay checks the final command again.
export function canStart(res: Res, D: Device, agent: string): boolean {
  const inactive = relay.startError(D, "post.start", { agent });
  if (inactive) fail(res, inactive.status, inactive.error);
  return !inactive;
}
// What a machine knows only it can say: its answer, or the last one with when it was read while it's off.
// `T`: what the machine answers this read.
export async function readOf<T extends Answer = Answer>(res: Res, D: Device, kind: string, args: Record<string, unknown>, { as = (d: T): object => d }: { as?: (d: T) => object } = {}) {
  const r = (await relay.read(D, kind, args)) as ReadAnswer<T>;
  if (r.error) return fail(res, r.status || 502, r.error, r.offline ? { offline: true } : {});
  const d = r.data;
  if (d?.error && d.status) return fail(res, d.status, d.error, d.cmd ? { cmd: d.cmd } : {});
  ok(res, { ...as(d), ...(r.cached && r.offline ? { as_of: r.fetched, offline: true } : {}) });
}
