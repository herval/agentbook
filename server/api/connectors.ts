// Connectors (connectors.ts): Linear and the rest, each one person's own with their own key, sealed (secrets.ts).

import * as boat from "../integrations/connectors/boat.ts";
import { MACHINE_KINDS, providerOf } from "../integrations/connectors/machines.ts";
import { accounts, commit, firstAdmin, log, relay, state } from "../core/state.ts";
import { fail, ok, readBody, route, str } from "../core/http.ts";
import type { Res, Viewer } from "../core/http.ts";
import type { SignedBody } from "../core/types.ts";
import { isOwner } from "../core/refs.ts";
import { cloud, connectors, dashboards } from "../core/services.ts";
import { said } from "./cli.ts";
import { confirmed } from "./images.ts";
import { terminals } from "./terminals.ts";
import { unlink } from "./mesh.ts";

// A connector as its form sends it (connectorInput): what's set of it, each only when it's sent.
interface ConnectorInput {
  id?: string;
  kind?: string | null;
  name?: string | null;
  api_key?: string | null;
  app_key?: string | null;
  workspace?: string | null;
  agent?: string | null;
  settings?: Record<string, string>;
  states?: string[];
  teams?: string[];
  close?: boolean;
  off?: boolean;
  every?: number;
}

export const connectorInput = (b: Record<string, unknown>) => {
  const out: ConnectorInput = {};
  for (const k of ["kind", "name", "api_key", "app_key", "workspace", "agent"]) if (b[k] !== undefined) out[k] = b[k] === null ? null : str(b[k], k === "api_key" || k === "app_key" ? 500 : 200);
  if (b.settings && typeof b.settings === "object" && !Array.isArray(b.settings)) out.settings = Object.fromEntries(Object.entries(b.settings).slice(0, 10).map(([k, v]) => [str(k, 40), str(v, 200)]));
  for (const k of ["states", "teams"]) if (b[k] !== undefined) out[k] = (Array.isArray(b[k]) ? b[k] : str(b[k], 500).split(/[\s,]+/)).slice(0, 40).map((x) => str(x, 40));
  for (const k of ["close", "off"]) if (b[k] !== undefined) out[k] = !!b[k];
  if (b.every !== undefined) out.every = Number(b.every) || undefined;
  return out;
};
export const connectorsMine = (req: Viewer, res: Res) => (req.user ? true : void fail(res, 403, "Connectors are set up where the page is."));
// Yours, and the kinds there are. What keeps them from being changed (no secret key) says how to fix it only to the
// server's first admin.
route("GET", "/api/connectors", (req, res) => connectorsMine(req, res) && ok(res, { kinds: connectors.kinds(), ...connectors.list(req.user.id, { owner: req.user.id === firstAdmin()?.id }) }));
route("POST", "/api/connectors", async (req, res) => {
  if (!connectorsMine(req, res)) return;
  const b = await readBody<Record<string, unknown>>(req);
  try {
    const input = connectorInput(b);
    const saved = await connectors.save({ ...input, ...(b.id ? { id: str(b.id, 100) } : {}) }, { uid: req.user.id, by: req.user.username, env: req.user.id === firstAdmin()?.id });
    // New keys, or another site or workspace: what it answered before isn't kept (dashboards.ts).
    if (b.id && (input.api_key !== undefined || input.app_key !== undefined || input.settings || input.workspace !== undefined)) dashboards.dropSource(str(b.id, 100));
    for (const D of relay.devices.values()) {
      if (!state.machine_cloud?.[D.id] || !isOwner(req, D)) continue;
      relay.nudge(D);
      // How long an idle or a busy machine stays up may have changed: its sandbox's auto-stop follows.
      if (saved.kind === "boat" && state.machine_cloud[D.id].connector === saved.id && input.settings) cloud.pace(D, { force: true }).catch(() => {});
    }
    ok(res, { connector: saved });
  } catch (e) {
    fail(res, e.status || 500, e.message);
  }
});
route("POST", "/api/connectors/:id/sync", async (req, res, { params }) => {
  if (!connectorsMine(req, res)) return;
  const c = await connectors.syncNow(params.id, req.user.id);
  if (!c) return fail(res, 404, "No such connector.");
  ok(res, { connector: c });
});
route("POST", "/api/connectors/:id/delete", async (req, res, { params }) => {
  if (!connectorsMine(req, res)) return;
  // A boat or exe.dev connector with machines: what becomes of them is its person's to say.
  // `machines: "delete"`: the ones agentbook made are deleted there, with
  // their boat environments, and an exe.dev one is taken off your account too; "leave": they stay there, and agentbook
  // stops managing them. Either way the ones only linked are unlinked.
  const b = await readBody<SignedBody & { machines?: string }>(req);
  const mine = [...relay.devices.values()].filter((D) => isOwner(req, D) && state.machine_cloud?.[D.id]?.connector === params.id);
  const c = mine.length ? connectors.byId(req.user.id, params.id, MACHINE_KINDS) : null;
  const p = c && providerOf(c.kind);
  if (mine.length && !["delete", "leave"].includes(b.machines)) return fail(res, 409, `It has ${mine.length === 1 ? "a machine" : `${mine.length} machines`}: say what becomes of ${mine.length === 1 ? "it" : "them"}.`, { machines: mine.map((D) => ({ name: D.name, made: !!state.machine_cloud[D.id].made })) });
  const made = mine.filter((D) => state.machine_cloud[D.id].made);
  if (b.machines === "delete" && made.length) {
    if (!c || !p) return fail(res, 409, "It's off or has no key, so its machines can't be deleted there. Turn it on first, or leave them there.");
    if (!confirmed(req, res, b, "cloud.delete", { connector: params.id })) return;
    for (const D of made) {
      const link = state.machine_cloud[D.id];
      try {
        await p.remove(c.key, link.sandbox);
      } catch (e) {
        return fail(res, 502, `${p.name} didn't delete ${D.name}'s sandbox, so nothing more was removed: ${e.message}`);
      }
      if (link.env && c.kind === "boat") await boat.dropEnvironment(c.key, link.env).catch(() => {});
      // An exe.dev machine joined your account through the relay: it comes off it, as Unlink does.
      if (link.kind === "exe") await unlink(D.name, req.user.username).catch((e) => log(`machine: ${D.name}: not unlinked: ${e.message}`));
      accounts.revokeDevice(D.id, req.user.id);
      relay.forget(D);
      terminals.forget(D.id);
      log(`machine: ${said(D.name)} deleted with @${req.user.username}'s ${p.name} connector, with its sandbox ${link.sandbox}`);
    }
  }
  for (const D of mine) {
    commit({ t: "machine.cloud", device: D.id });
    cloud.forget(D);
  }
  try {
    if (!connectors.remove(params.id, req.user.id)) return fail(res, 404, "No such connector.");
  } catch (e) {
    return fail(res, e.status || 500, e.message);
  }
  // Their cloud machines hear now, not at their next poll, that git there may have lost its GitHub sign-in (gitGithub).
  for (const D of relay.devices.values()) if (state.machine_cloud?.[D.id] && isOwner(req, D)) relay.nudge(D);
  dashboards.dropSource(params.id);
  ok(res);
});
