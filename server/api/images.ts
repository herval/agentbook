import fs from "node:fs";
import { bundle, ticketOf } from "../cli-bundle.ts";
import { assertionRefusal, digestOf } from "../../plugin/shared/signed.ts";
import { accounts, relay, state } from "../core/state.ts";
import { PUBLIC_ORIGIN, fail, ok, readBody, route, send, str } from "../core/http.ts";
import type { Req, Res } from "../core/http.ts";
import type { SignedBody } from "../core/types.ts";
import { isOwner } from "../core/refs.ts";
import { connectors, images } from "../core/services.ts";
import { connectorsMine } from "./connectors.ts";


// What spends your money on boat, or makes or deletes a machine, you confirm with a passkey when you have one:
// a session cookie alone doesn't do it. Unsigned, it's answered with what to sign
// (428, as a machine's signed commands are: the page signs it and sends it again): { v: 1, kind, user, ...about, at }.
// It holds on this page, within five minutes, once. -> true when it's confirmed; else it has answered.
const confirmedOnce = new Set();
export function confirmed(req: Req, res: Res, b: SignedBody, kind: string, about: Record<string, unknown> = {}) {
  const keys = accounts.passkeys(req.user.id);
  if (!keys.length) return true;
  const e = b.signed?.envelope;
  if (!e || typeof e !== "object" || !b.signed.sig) return void send(res, 428, { error: "Confirm it with your passkey.", sign: { v: 1, kind, user: req.user.username, ...about, at: new Date().toISOString() }, keys: keys.map((k) => k.id) });
  const no = (why) => void fail(res, 403, why);
  if (e.kind !== kind || e.user !== req.user.username || Object.entries(about).some(([k, v]) => e[k] !== v)) return no("What your passkey signed isn't this.");
  if (!(Math.abs(Date.now() - Date.parse(e.at)) < 5 * 60e3)) return no("That confirmation is too old. Confirm it again.");
  const digest = digestOf(e);
  if (confirmedOnce.has(digest)) return no("That confirmation was used already. Confirm it again.");
  const why = assertionRefusal(e, b.signed.sig, { keys, origin: String(req.headers.origin || PUBLIC_ORIGIN), rpId: String(req.headers.host || "").replace(/:\d+$/, "") });
  if (why) return no(`Your passkey didn't confirm it: ${why}.`);
  confirmedOnce.add(digest);
  setTimeout(() => confirmedOnce.delete(digest), 6 * 60e3).unref();
  return true;
}
// Your images, what there is to pick, and your boat connectors to build them with.
route("GET", "/api/images", (req, res) => connectorsMine(req, res) && ok(res, { images: images.mine(req.user.id), ...images.catalog(), boat: connectors.ofKind(req.user.id, "boat"), signs: accounts.passkeys(req.user.id).length > 0 }));
// Make one, or change one's draft ({ id }).
route("POST", "/api/images", async (req, res) => {
  if (!connectorsMine(req, res)) return;
  const b = await readBody<{ id?: string; name?: string; connector?: string; def?: unknown }>(req);
  try {
    ok(res, images.save(req.user.id, { id: b.id ? str(b.id, 80) : null, name: b.name === undefined ? undefined : str(b.name, 60), connector: b.connector ? str(b.connector, 100) : null, def: b.def && typeof b.def === "object" ? b.def : undefined }));
  } catch (e) {
    fail(res, e.status || 500, e.message);
  }
});
// Build its draft: its next version, on a builder sandbox on your boat account.
route("POST", "/api/images/:id/build", async (req, res, { params }) => {
  if (!connectorsMine(req, res)) return;
  const b = await readBody<SignedBody>(req);
  if (!confirmed(req, res, b, "image.build", { image: params.id })) return;
  try {
    ok(res, { image: await images.build(req.user.id, params.id) });
  } catch (e) {
    fail(res, e.status || 500, e.message);
  }
});
route("POST", "/api/images/:id/delete", async (req, res, { params }) => {
  if (!connectorsMine(req, res)) return;
  const b = await readBody<SignedBody>(req);
  if (!confirmed(req, res, b, "image.delete", { image: params.id })) return;
  const used = [...relay.devices.values()].filter((D) => state.machine_cloud?.[D.id]?.image === params.id && isOwner(req, D));
  try {
    await images.remove(req.user.id, params.id);
    ok(res, { machines: used.map((D) => D.name) });
  } catch (e) {
    fail(res, e.status || 500, e.message);
  }
});
// What a build's script printed, whole.
route("GET", "/api/images/:id/builds/:v/log", (req, res, { params }) => {
  if (!connectorsMine(req, res)) return;
  const text = images.log(req.user.id, params.id, Number(params.v));
  if (text == null) return fail(res, 404, "No such build of yours.");
  ok(res, { log: text });
});
// agentbook-cli and the plugin, for a build's or a new machine's script: with its ticket, for an hour.
route("GET", "/api/cli/bundle", (req, res, { query }) => {
  const t = ticketOf(query.get("t"));
  const b = t && bundle();
  if (!b) return fail(res, 404, "No such download, or it ran out.");
  res.writeHead(200, { "content-type": "application/gzip", "content-length": b.size, "cache-control": "no-store" });
  fs.createReadStream(b.file).pipe(res);
});
// Who git is on GitHub while a build clones its repos: the build's owner, with their GitHub connector's token, in
// the lines git's credential helpers speak. Only with the build's ticket, and only while it lasts.
route("GET", "/api/cli/git", (req, res, { query }) => {
  const t = ticketOf(query.get("t"));
  const token = t?.git ? connectors.keyFor(t.uid, "github") : null;
  if (!token) return fail(res, 404, "No GitHub sign-in for this.");
  res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
  res.end(`username=x-access-token\npassword=${token}\n`);
});
