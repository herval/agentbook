// Your other machines, linked to this one (../mesh.ts): every machine on your account links to each other one whose
// page it reaches, by its certificate. Then each machine takes what you sign on the other's page once you OK that page
// on its own (Sign once, keys.vouch).

import { createMesh, type Unlinked } from "../mesh.ts";
import { ACCOUNT, PUBLIC_URL } from "../config.ts";
import { HOME } from "../../plugin/shared/home.ts";
import { accounts, log, relay, storage } from "../core/state.ts";
import { fail, ok, readBody, route } from "../core/http.ts";
import type { Viewer } from "../core/http.ts";
import { deviceFor, ownerOf, viewerName } from "../core/refs.ts";
import { keysOf } from "../core/commands.ts";
import type { Answer, SignedBody } from "../core/types.ts";
import { deviceOf, logRefused } from "./cli.ts";
import { firstAccountMade } from "./people.ts";
import { terminals } from "./terminals.ts";
import { meshChanged } from "../../plugin/shared/storage/peers.ts";

const mesh = createMesh({
  storage,
  accounts,
  adopt: (id, old, as) => relay.adopt(id, old, as),
  publicUrl: PUBLIC_URL,
  home: HOME,
  account: ACCOUNT,
  adopted: firstAccountMade,
  dropped: (name) => void unlinkHere(name),
  log,
});

// Another machine of your account's says hello over iroh, with its certificate, signed with its key.
route("POST", "/api/cli/mesh/link", async (req, res) => {
  const text = (await readBody(req, true)).toString("utf8");
  const r = await mesh.linked(req.headers.authorization, text, (req.socket as { irohKey?: string }).irohKey);
  if ("error" in r) {
    logRefused(`mesh: link refused (${r.status}: ${r.error})`, req);
    return fail(res, r.status, r.error);
  }
  ok(res, r);
});

// A machine linked to this one asks for your passkeys here, for its own to take what you sign on this page.
route("GET", "/api/cli/mesh/site", (req, res) => {
  const D = deviceOf(req, res);
  if (!D) return;
  const uid = ownerOf(D)?.id;
  if (!uid) return fail(res, 403, "That machine is nobody's here.");
  const r = mesh.site(D, uid);
  "error" in r ? fail(res, r.status, r.error) : ok(res, r);
});
// A machine of yours linked to this one, for its row in Machines: its page, whether this machine takes what you sign
// there (`takes`), whether it takes what you sign here (`signs`), whether they talk over iroh and how that goes now
// (`path`: direct, or through the relay), and, for one this machine sends nothing to, why (`why`). Null for one that
// isn't linked.
export function linkedOf(req: Viewer, name: string): { url: string | null; takes: boolean; signs: boolean; iroh: boolean; path: "direct" | "relay" | null; why?: string } | null {
  const p = mesh.list().find((x) => x.name === name);
  if (!p) return null;
  const why = mesh.whyOf(name);
  const own = mesh.machine() ? deviceFor(req, mesh.machine()) : null;
  const D = deviceFor(req, name);
  const sitesOf = (M) => (M && relay.infoOf(M)?.machine?.gate?.signed?.sites) || [];
  return { url: p.site, takes: !!p.site && sitesOf(own).some((x) => x.origin === p.site), signs: sitesOf(D).some((x) => x.origin === new URL(PUBLIC_URL).origin), iroh: p.iroh, path: p.path, ...(why ? { why } : {}) };
}
// Your account's machines this page isn't linked with yet, and why, for Machines.
export const notLinked = (): Unlinked[] => mesh.others();
// Why this machine isn't on iroh, when it should be (not installed), for Machines.
export const irohWhyHere = (): string | null => mesh.irohWhy();
// Sign once: this machine takes what you sign on the page of `name`, a machine linked to it, from now on. Its gate
// takes that signed by a passkey of yours it keeps (428 with what to sign), or, from its own page, as it takes
// anything from it while it keeps none and its server is itself.
route("POST", "/api/mesh/:name/vouch", async (req, res, { params }) => {
  const own = mesh.machine() ? deviceFor(req, mesh.machine()) : null;
  if (!own) return fail(res, 409, "This page's own machine isn't connected to it as yours.");
  if (!relay.online(own)) return fail(res, 409, `${own.name} is off: sign once it's back.`);
  const site = await mesh.siteOf(params.name);
  if ("error" in site) return fail(res, site.status, site.error);
  const g = relay.infoOf(own)?.machine?.gate;
  const b = await readBody<SignedBody>(req).catch((): SignedBody => ({}));
  let vouch;
  if (g?.signed?.keys?.length) {
    if (!b?.signed) return fail(res, 428, `${own.name} takes what's signed on ${site.machine || params.name}'s page once your passkey signs that here.`, { sign: { v: 1, kind: "keys.vouch", machine: g.signed.machine, name: site.machine || params.name, site: { origin: site.origin, rp_id: site.rp_id, keys: site.keys }, at: new Date().toISOString() }, keys: keysOf(req.user.id) });
    const e = b.signed.envelope;
    if (e?.kind !== "keys.vouch" || (e.site as { origin?: string } | undefined)?.origin !== site.origin) return fail(res, 400, "That's signed for something else.");
    vouch = { envelope: e, sig: b.signed.sig };
  } else vouch = { envelope: { v: 1, kind: "keys.vouch", machine: g?.signed?.machine ?? null, name: site.machine || params.name, site: { origin: site.origin, rp_id: site.rp_id, keys: site.keys }, at: new Date().toISOString() } };
  const r = (await relay.command(own, "keys.vouch", { vouch }, { by: viewerName(req), wait: 20e3 })) as Answer;
  if (r?.error) return fail(res, r.status || 409, r.error);
  log(`mesh: ${own.name} takes what's signed on ${site.origin} (${site.keys.length} key${site.keys.length === 1 ? "" : "s"}), as @${viewerName(req)} said`);
  ok(res, { takes: site.origin, keys: site.keys.length });
});

// ---------- unlinking ----------
// `name` isn't linked to this machine any more, here: its row goes (this machine stops sending it threads, taking its
// commands, and taking what's signed on its page) and so does its token on this page (it sends nothing more here, as
// after Disconnect). What it sent stays as it was. Only a linked machine: one only logged in here, with the same name,
// is never touched. -> whether it was linked.
function unlinkHere(name: string): boolean {
  const row = mesh.forget(name);
  if (!row) return false;
  const d = accounts.deviceNamed(row.name);
  if (d) {
    accounts.revokeDevice(d.id, d.user_id);
    const D = relay.devices.get(d.id);
    if (D) relay.forget(D);
    terminals.forget(d.id);
  }
  return true;
}
// Unlinks `name`: the relay takes it off your account (so all your machines drop it), then its page is told, with this
// machine's token there, as that token goes once this page unlinks it. -> whether that page heard; one that didn't
// drops this machine as it next hears from the relay.
export async function unlink(name: string, by: string): Promise<{ unlinked: string; told: boolean } | null> {
  const row = mesh.get(name);
  if (!row) return null;
  await mesh.takeOff(row);
  const told = await mesh.tell(row);
  unlinkHere(row.name);
  log(`mesh: unlinked ${JSON.stringify(row.name)}, as @${by} said${told ? ", and its page did too" : `: its page didn't hear, so it drops this machine as it next hears from the relay`}`);
  return { unlinked: row.name, told };
}
// Unlink, from a linked machine's row in Machines.
route("POST", "/api/mesh/:name/unlink", async (req, res, { params }) => {
  const D = deviceFor(req, params.name);
  if (!D || ownerOf(D)?.id !== req.user.id || !mesh.get(D.name)) return fail(res, 404, `${params.name} isn't a machine of yours linked to this one.`);
  ok(res, await unlink(D.name, viewerName(req)));
});
// The other page unlinks this machine, with its token here: this page does the same, and asks the relay, which has
// most likely taken this machine off your account (then it drops every machine it was linked to).
route("POST", "/api/cli/mesh/unlink", (req, res) => {
  const D = deviceOf(req, res);
  if (!D) return;
  if (!mesh.get(D.name)) return fail(res, 403, "Only a machine linked to this one unlinks itself from it.");
  unlinkHere(D.name);
  log(`mesh: ${JSON.stringify(D.name)} unlinked this machine, so this one unlinked it too`);
  ok(res, {});
  void mesh.refresh();
});
// A linked machine's page refused this machine, and still did a while later (plugin/cli/main.ts): it dropped this
// machine while this one was off, or lost it. The relay says which.
meshChanged.on("refused", (r: { name: string; key: string }) => void mesh.refused(r));
// A linked machine connected here (POST /api/cli/hello): still on your account?
meshChanged.on("hello", (name: string) => void mesh.check(name));
// A person came to this page: it links to the machines that wouldn't link to a page with nobody on it.
meshChanged.on("person", () => void mesh.nudge());

// This machine's name, as its daemon has it: with it, the page links to your other machines.
export const setMachine = (name: string) => mesh.setMachine(name);
// The machines it's linked to.
export const meshPeers = () => mesh.list();
export const unlinkMesh = async (name: string) => (await unlink(name, "this machine's owner")) || Promise.reject(Object.assign(new Error(`${name} isn't linked to this machine.`), { status: 404 }));
