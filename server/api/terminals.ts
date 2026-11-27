import { createTerminals } from "../terminals.ts";
import { log, relay } from "../core/state.ts";
import { fail, ok, readBody, route } from "../core/http.ts";
import type { Res, Viewer } from "../core/http.ts";
import type { Answer } from "../core/types.ts";
import { viewerName } from "../core/refs.ts";
import { postOr404 } from "../core/follows.ts";
import { signedOr428 } from "../core/commands.ts";
import { signedInNow } from "./views.ts";

// Terminals in threads' folders, for their owners (terminals.ts).
export const terminals = createTerminals({
  whoIs: (req) => signedInNow(req),
  ownerOf: (device) => relay.devices.get(device)?.user_id ?? null,
  postOf: (device, local) => {
    const D = relay.devices.get(device);
    return D?.store.state.sessions[local] ? relay.idOf(D, local) : null;
  },
  log,
});

/* ---------- terminals: a shell in a thread's folder, for its owner (terminals.ts) ---------- */

// The terminal of yours open on a thread, or none.
route("GET", "/api/sessions/:id/terminal", (req, res, { params }) => {
  const p = postOr404(req, res, params.id, "own");
  if (!p) return;
  const T = terminals.forPost(req.user.id, relay.idOf(p.D, p.local));
  ok(res, { terminal: T ? terminals.summary(T) : null });
});
// Open one: its machine's gate starts a shell in the thread's folder, as the machine has it (term.open), signed with
// your passkey when the machine wants that. One that's open already is the one you get.
route("POST", "/api/sessions/:id/terminal", async (req, res, { params }) => {
  const p = postOr404(req, res, params.id, "own");
  if (!p) return;
  const post = relay.idOf(p.D, p.local);
  if (p.s.cloud) return fail(res, 409, "It runs in the cloud, so it has no folder on a machine of yours.");
  if (!relay.online(p.D)) return fail(res, 503, `${p.D.name} is off.`);
  const had = terminals.forPost(req.user.id, post);
  if (had) return ok(res, { terminal: terminals.summary(had) });
  const b = await readBody<{ cols?: number; rows?: number }>(req).catch((): { cols?: number; rows?: number } => ({}));
  const size = (n: unknown, lo: number, hi: number, or: number) => Math.max(lo, Math.min(hi, Math.round(Number(n)) || or));
  let args: Record<string, unknown> = { tid: terminals.newId(), post: p.local, cols: size(b.cols, 2, 500, 80), rows: size(b.rows, 1, 300, 24) };
  const signed = await signedOr428(req, res, p.D, "term.open", args);
  if (signed === false) return;
  if (signed) args = signed.envelope.args;
  if (args.post !== p.local) return fail(res, 400, "That's signed for another thread.");
  const T = terminals.open({ tid: args.tid, device: p.D.id, uid: req.user.id, post });
  if ("error" in T) return fail(res, T.status, T.error);
  const r = (await relay.command(p.D, "term.open", args, { by: viewerName(req), wait: 20e3, signed })) as Answer & { cwd?: string; shell?: string; tid?: string };
  if (r?.queued || (r?.error && r.status)) {
    terminals.drop(T);
    return fail(res, r.queued ? 504 : r.status, r.queued ? `${p.D.name} didn't answer in time.` : r.error);
  }
  ok(res, { terminal: terminals.summary(terminals.opened(T, r)) });
});
// Yours, by its id: closing it (what it shows, and what you type in it, go on its WebSocket: main.ts's upgraded).
function terminalOr404(req: Viewer, res: Res, tid: string) {
  const T = terminals.of(tid);
  if (!T || T.uid !== req.user.id || relay.devices.get(T.device)?.user_id !== req.user.id) return void fail(res, 404, "No such terminal");
  return T;
}
// More time to type in it: a machine whose server is elsewhere takes what's typed only for a while after your
// passkey signs something (term.lease, opening it, a run in it).
route("POST", "/api/terminals/:tid/lease", async (req, res, { params }) => {
  const T = terminalOr404(req, res, params.tid);
  if (!T) return;
  const D = relay.devices.get(T.device);
  if (!relay.online(D)) return fail(res, 503, `${D.name} is off.`);
  let args: Record<string, unknown> = { tid: T.tid };
  const signed = await signedOr428(req, res, D, "term.lease", args);
  if (signed === false) return;
  if (signed) args = signed.envelope.args;
  if (args.tid !== T.tid) return fail(res, 400, "That's signed for another terminal.");
  const r = (await relay.command(D, "term.lease", args, { by: viewerName(req), wait: 20e3, signed })) as Answer;
  if (r?.queued || (r?.error && r.status)) return fail(res, r.queued ? 504 : r.status, r.queued ? `${D.name} didn't answer in time.` : r.error);
  ok(res);
});
route("POST", "/api/terminals/:tid/close", (req, res, { params }) => {
  const T = terminalOr404(req, res, params.tid);
  if (!T) return;
  terminals.close(T);
  ok(res);
});
