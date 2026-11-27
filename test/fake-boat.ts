// A stand-in boat (boat.dev), for the boat tests: the endpoints agentbook's boat connector asks
// (server/integrations/connectors/boat.ts), answering as boat's API reference says they do (docs.boat.dev/api/v1):
// a bearer key, { ok, type, ... } bodies, errors as { ok: false, type: "sandbox.error", status, code, message, error }.
// It keeps what it was asked (`calls`). Tests never reach boat itself.
//
// startBoat({ key, sandboxes: [{ id, name, state }], onResume(id), onCreate(sandbox, body), onStop(id) })
//   -> { url, calls, sandboxes, snapshots, environments, set(opts), close() }
// - set({ refuse: { status, code, message, retryAfter } | null }): what a resume or a create answers instead of yes.
// - set({ scopes }): the key's actions (null: all of them), as docs.boat.dev/api-keys/scopes names them.
// - set({ trial: true }): the free trial, where an auto-stop past two hours is refused.
// - set({ orgs }): the organizations the account is in, by name. set({ limits }): what GET /limits answers.
// - set({ setup: { status, error, log } }): how a new sandbox's setup script ends ("done" unless said).
// - set({ save: "failed" | "ready" }): how a saved snapshot ends.
// A sandbox it makes is "provisioning" for 150 ms, then "ready", its setup "running" then as `setup` says.

import http from "node:http";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";

// A sandbox, as boat's API has it.
export interface Sandbox {
  id: string;
  name: string;
  state: string;
  desktopAvailable?: boolean;
  snapshotAvailable?: boolean;
  dataExpiredAt?: string | null;
  labels?: Record<string, string>;
  type?: string;
  ttlSeconds?: number | null;
  stopsAt?: string | null;
  environment?: string | null;
  noEnv?: boolean;
  monitoring?: boolean;
  from?: string | null;
  org?: string | null;
  setupStatus?: string | null;
  setupError?: string | null;
  // Made through the API, not given by the test.
  made?: boolean;
}
export interface Snapshot {
  name: string;
  status: string;
  sourceSandboxId: string;
  type: string;
  sizeBytes: number;
  createdAt: string;
  snapshotId?: string;
  error?: string;
}
export interface Environment {
  id: string;
  name: string;
  isDefault: boolean;
  latestVersionId: string;
  safeForThirdParties: boolean;
  passGithub: boolean;
  passSecrets: boolean;
  passSandboxCredentials: boolean;
  passAgentsCredentials: boolean;
  // .env-style text.
  envContents: string;
  secretFiles: unknown[];
  versions: unknown[];
  // How many times it was upgraded.
  upgraded?: number;
}
// A file a new sandbox starts with.
export interface BoatFile {
  path: string;
  content: string;
  encoding?: "utf8" | "base64";
}
// What agentbook sends: a sandbox to make or change, a snapshot to save, an environment or a variable to set.
export interface BoatBody {
  name?: string;
  from?: string;
  type?: string;
  environment?: string;
  org?: string;
  files?: BoatFile[];
  ttlSeconds?: number | null;
  labels?: Record<string, string>;
  noEnv?: boolean;
  monitoring?: boolean;
  setupScript?: string;
  subdomain?: string;
  sandboxId?: string;
  value?: string;
  [field: string]: unknown;
}
// What a test asked boat to do instead of yes, and how things go there (see above).
export interface BoatOpts {
  refuse: { status: number; code: string; message?: string; retryAfter?: number } | null;
  scopes: string[] | null;
  trial: boolean;
  orgs: string[];
  limits: Record<string, unknown> | null;
  setup: { status: string; error?: string | null; log?: string };
  save: "ready" | "failed";
}
export interface BoatCall {
  method: string;
  path: string;
  query: string;
  body: BoatBody | null;
  headers: { idempotency: string | null; confirm: string | null; org: string | null };
}
interface BoatOptions {
  key?: string;
  sandboxes?: Sandbox[];
  onResume?: (id: string) => void;
  onCreate?: (sandbox: Sandbox, body: BoatBody | null, files: Map<string, string>) => void;
  onStop?: (id: string) => void;
}

const ON = ["ready", "idle", "running"];
const ID = "23456789abcdefghjkmnpqrstuvwxyz";
const newId = () => `bx_${Array.from(crypto.randomBytes(8), (b) => ID[b % ID.length]).join("")}`;

export async function startBoat({ key = "boat_test_0123456789abcdef", sandboxes = [], onResume = () => {}, onCreate = () => {}, onStop = () => {} }: BoatOptions = {}) {
  const calls: BoatCall[] = [];
  const boxes = new Map<string, Sandbox>(sandboxes.map((s): [string, Sandbox] => [s.id, { desktopAvailable: false, snapshotAvailable: true, dataExpiredAt: null, labels: {}, ...s }]));
  const snapshots = new Map<string, Snapshot>(); // name -> { name, status, sourceSandboxId, type, createdAt, snapshotId }
  const environments = new Map<string, Environment>(); // id -> { id, name, isDefault, passGithub, ..., envContents }
  const files = new Map<string, string>(); // "<sandbox> <path>" -> content
  const idem = new Map<string, string>(); // idempotency key -> sandbox id
  const usage = new Map<string, number>(); // sandbox -> seconds
  const opts: BoatOpts = { refuse: null, scopes: null, trial: false, orgs: [], limits: null, setup: { status: "done", error: null, log: "" }, save: "ready" };
  const env = (name: string) => [...environments.values()].find((e) => e.name === name);
  const newEnv = (name: string, isDefault = false) => {
    const e: Environment = { id: crypto.randomUUID(), name, isDefault, latestVersionId: crypto.randomUUID(), safeForThirdParties: false, passGithub: true, passSecrets: true, passSandboxCredentials: true, passAgentsCredentials: true, envContents: "", secretFiles: [], versions: [] };
    environments.set(e.id, e);
    return e;
  };
  newEnv("base", true);

  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const url = new URL(req.url, "http://x");
    const path = url.pathname.replace(/^\/api\/v1/, "");
    let body: BoatBody | null = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {}
    const header = (name: string) => [req.headers[name]].flat()[0] || null;
    calls.push({ method: req.method, path, query: url.search, body, headers: { idempotency: header("idempotency-key"), confirm: header("x-ascii-confirm-delete"), org: header("x-boat-org") } });
    const send = (status: number, out: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(out));
    };
    const no = (status: number, code: string, message: string, extra: object = {}, headers: Record<string, string> = {}) => send(status, { ok: false, type: "sandbox.error", status, code, message, error: { code, message, status }, requestId: "req_test", ...extra }, headers);
    if (req.headers.authorization !== `Bearer ${key}`) return no(401, "unauthorized", "Unauthorized");
    const can = (scope: string) => !opts.scopes || opts.scopes.includes(scope) || opts.scopes.includes("*");
    const need = (scope: string) => (can(scope) ? false : (no(403, "api_key_action_forbidden", "This API key can't do that."), true));
    const refused = () => {
      const r = opts.refuse;
      if (!r) return false;
      no(r.status, r.code, r.message || r.code, r.retryAfter ? { retryAfterSeconds: r.retryAfter } : {}, r.retryAfter ? { "retry-after": String(r.retryAfter) } : {});
      return true;
    };
    const M = req.method;

    /* ---------- the account ---------- */
    if (M === "GET" && path === "/me") return need("account.read") || send(200, { ok: true, type: "user.info", user: { id: "acct_1", login: "herval", email: "herval@acme.test" } });
    if (M === "GET" && path === "/orgs") return need("account.read") || send(200, { ok: true, type: "org.list", activeWalletChosen: false, orgs: [{ id: "acct_1", name: "Personal", type: "personal", role: "owner", memberCount: 1, active: true }, ...opts.orgs.map((name, i) => ({ id: `team_${i + 1}`, name, type: "org", role: "member", memberCount: 3, active: false }))] });
    if (M === "GET" && path === "/limits")
      return (
        need("account.read") ||
        send(200, { ok: true, type: "limits.info", canStart: true, activeSandboxes: [...boxes.values()].filter((s) => ON.includes(s.state)).length, sandboxPlanKey: "box_20", sandboxPlanDollars: 20, maxActiveSandboxes: 100, billingStatus: "active", wallet: { balanceDollars: 52.4 }, planIncluded: { vmHours: 555.56, vmHoursRemaining: 312.7, periodEnd: "2026-12-01T00:00:00.000Z" }, overagePrices: { vmHourDollars: 0.036 }, giftLimit: null, ...(url.searchParams.get("org") ? { teamId: url.searchParams.get("org") } : {}), ...(opts.limits || {}) })
      );

    /* ---------- sandboxes ---------- */
    if (M === "GET" && path === "/sandboxes") {
      if (need("sandbox.read")) return;
      const states = (url.searchParams.get("state") || "").split(",").filter(Boolean);
      const labels = url.searchParams.getAll("label").map((l) => l.split("="));
      const list = [...boxes.values()].filter((s) => (!states.length || states.includes(s.state)) && labels.every(([k, v]) => s.labels?.[k] === v));
      return send(200, { ok: true, type: "sandbox.list", sandboxes: list.slice(0, Number(url.searchParams.get("limit")) || 100), pageInfo: { nextCursor: null, hasMore: false, limit: 100 } });
    }
    if (M === "POST" && path === "/sandboxes") {
      if (need("sandbox.create")) return;
      if (body?.from && need("snapshot.read")) return;
      const again = header("idempotency-key") && idem.get(header("idempotency-key"));
      if (again) return send(202, { ok: true, type: "sandbox.created", status: "ready", ttlSeconds: boxes.get(again).ttlSeconds, sandbox: { ...boxes.get(again) } });
      if (refused()) return;
      if (body?.from && snapshots.get(body.from)?.status !== "ready") return no(404, "snapshot_not_found", "Saved snapshot not found");
      if (body?.environment && !env(body.environment)) return no(400, "unknown_environment", "Unknown environment");
      if (body?.org && body.org !== "personal" && !opts.orgs.some((o) => o.toLowerCase() === String(body.org).toLowerCase())) return no(404, "org_not_found", "No such organization");
      for (const f of body?.files || []) if (!/^(\/home\/user\/|\/tmp\/|[^/])/.test(f.path)) return no(400, "invalid_files", "Bad path");
      const box: Sandbox = { id: newId(), name: body?.name || body?.from || "Boat", state: "provisioning", desktopAvailable: false, snapshotAvailable: true, dataExpiredAt: null, type: body?.type || snapshots.get(body?.from)?.type || "default", ttlSeconds: body?.ttlSeconds === undefined ? 3600 : body.ttlSeconds, labels: body?.labels || {}, environment: body?.noEnv ? null : body?.environment || "base", noEnv: !!body?.noEnv, monitoring: body?.monitoring !== false, from: body?.from || null, org: body?.org || null, setupStatus: body?.setupScript || body?.files?.length ? "pending" : null, setupError: null, made: true };
      boxes.set(box.id, box);
      if (header("idempotency-key")) idem.set(header("idempotency-key"), box.id);
      for (const f of body?.files || []) files.set(`${box.id} ${f.path.startsWith("/") ? f.path : `/home/user/${f.path}`}`, f.encoding === "base64" ? Buffer.from(f.content, "base64").toString() : f.content);
      setTimeout(() => {
        if (!boxes.has(box.id)) return;
        box.state = "ready";
        if (box.setupStatus) box.setupStatus = body?.setupScript ? "running" : "done";
        onCreate(box, body, files);
        if (body?.setupScript)
          setTimeout(() => {
            if (!boxes.has(box.id)) return;
            box.setupStatus = opts.setup.status;
            box.setupError = opts.setup.status === "failed" ? opts.setup.error || "exit 1" : null;
            files.set(`${box.id} /home/user/.agentbook-build.log`, opts.setup.log || "");
          }, 150);
      }, 150);
      return send(202, { ok: true, type: "sandbox.created", status: "provisioning", ttlSeconds: box.ttlSeconds, sandbox: { ...box } });
    }
    const m = path.match(/^\/sandboxes\/([^/]+)(\/resume|\/stop|\/usage|\/files)?$/);
    const box = m && boxes.get(decodeURIComponent(m[1]));
    if (m && !box) return no(404, "not_found", "Sandbox not found");
    if (m && !m[2] && M === "GET") return need("sandbox.read") || send(200, { ok: true, type: "sandbox.info", ...box, sandbox: { ...box } });
    if (m && !m[2] && M === "PATCH") {
      if (need("sandbox.update")) return;
      if (!body || !["name", "ttlSeconds", "subdomain"].some((k) => k in body)) return no(400, "no_changes", "Nothing to change");
      if ("ttlSeconds" in body && opts.trial && (body.ttlSeconds == null || body.ttlSeconds > 7200)) return no(400, "trial_auto_stop_required", "The trial needs an auto-stop of 2 hours or less.");
      if ("ttlSeconds" in body) Object.assign(box, { ttlSeconds: body.ttlSeconds, stopsAt: body.ttlSeconds == null ? null : new Date(Date.now() + body.ttlSeconds * 1000).toISOString() });
      if (body.name) box.name = body.name;
      return send(200, { ok: true, type: "sandbox.info", sandbox: { ...box } });
    }
    if (m && !m[2] && M === "DELETE") {
      // A key with only delete-own deletes what it made.
      if (!can("sandbox.delete") && !(can("sandbox.delete-own") && box.made)) return no(403, "api_key_action_forbidden", "This API key can't do that.");
      if (req.headers["x-ascii-confirm-delete"] !== box.id) return no(409, "confirmation_required", "Confirm the deletion.");
      boxes.delete(box.id);
      return send(202, { ok: true, type: "sandbox.deleting", operation: { id: `del_${box.id}`, status: "accepted" } });
    }
    if (m && m[2] === "/usage" && M === "GET") {
      if (need("sandbox.read")) return;
      const seconds = usage.get(box.id) ?? 4980;
      return send(200, { ok: true, type: "sandbox.usage", sandboxId: box.id, sandboxType: box.type || "default", billingMultiplier: 1, since: url.searchParams.get("since") || "2026-11-08T00:00:00.000Z", until: new Date().toISOString(), seconds, dollars: seconds / 100000, secondsPerDollar: 100000, running: ON.includes(box.state) });
    }
    if (m && m[2] === "/files" && M === "GET") {
      if (need("file.read")) return;
      const p = url.searchParams.get("path") || "";
      const content = files.get(`${box.id} ${p.startsWith("/") ? p : `/home/user/${p}`}`);
      if (content === undefined) return no(404, "file_not_found", "No such file");
      return send(200, { ok: true, type: "file.read", success: true, path: p, encoding: "utf8", size: content.length, content });
    }
    if (m && m[2] === "/stop" && M === "POST") {
      if (need("sandbox.stop")) return;
      box.state = "archived";
      onStop(box.id);
      return send(202, { ok: true, type: "sandbox.stopping", id: box.id, status: "stopping", sandbox: { ...box } });
    }
    if (m && m[2] === "/resume" && M === "POST") {
      if (need("sandbox.resume")) return;
      if (refused()) return;
      if (box.dataExpiredAt) return no(409, "snapshot_data_expired", "The snapshot data expired.");
      box.state = "provisioning";
      setTimeout(() => {
        box.state = "ready";
        onResume(box.id);
      }, 200);
      return send(202, { ok: true, type: "sandbox.resuming", id: box.id, status: "resuming", sandbox: { ...box } });
    }

    /* ---------- saved snapshots ---------- */
    if (M === "GET" && path === "/saved-snapshots") return need("snapshot.read") || send(200, { ok: true, type: "saved-snapshot.list", snapshots: [...snapshots.values()], savedSnapshots: [...snapshots.values()] });
    if (M === "POST" && path === "/saved-snapshots") {
      if (need("snapshot.write")) return;
      if (!boxes.has(body?.sandboxId)) return no(404, "not_found", "Sandbox not found");
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(body?.name || "")) return no(400, "invalid_name", "Bad name");
      if (opts.limits?.sandboxPlanKey === "trial") return no(402, "credit_required", "Saved snapshots need a plan.");
      const snap: Snapshot = { name: body.name, status: "saving", sourceSandboxId: body.sandboxId, type: boxes.get(body.sandboxId).type || "default", sizeBytes: 123456789, createdAt: new Date().toISOString() };
      snapshots.set(snap.name, snap);
      setTimeout(() => Object.assign(snap, opts.save === "failed" ? { status: "failed", error: "The capture failed." } : { status: "ready", snapshotId: `snap_${snap.name}` }), 150);
      return send(202, { ok: true, type: "saved-snapshot.saving", snapshot: { ...snap }, savedSnapshot: { ...snap } });
    }
    const sm = path.match(/^\/saved-snapshots\/([^/]+)$/);
    const snap = sm && snapshots.get(decodeURIComponent(sm[1]));
    if (sm && !snap) return no(404, "snapshot_not_found", "Saved snapshot not found");
    if (sm && M === "GET") return need("snapshot.read") || send(200, { ok: true, type: "saved-snapshot.info", snapshot: { ...snap }, savedSnapshot: { ...snap } });
    if (sm && M === "DELETE") {
      if (need("snapshot.write")) return;
      snapshots.delete(snap.name);
      return send(200, { ok: true, type: "saved-snapshot.deleted", name: snap.name });
    }

    /* ---------- environments ---------- */
    if (M === "GET" && path === "/environments") return need("environment.read") || send(200, { ok: true, type: "environments.list", environments: [...environments.values()] });
    if (M === "POST" && path === "/environments") {
      if (need("environment.write")) return;
      if (!/^[a-zA-Z0-9._-]{1,64}$/.test(body?.name || "")) return no(400, "invalid_name", "Bad name");
      if (env(body.name)) return no(409, "environment_exists", "An environment has that name already.");
      newEnv(body.name);
      return send(200, { ok: true, type: "environments.list", environments: [...environments.values()] });
    }
    const em = path.match(/^\/environments\/([^/]+)(\/upgrade|\/vars\/([^/]+))?$/);
    const e = em && environments.get(decodeURIComponent(em[1]));
    if (em && !e) return no(404, "not_found", "Environment not found");
    if (em && need("environment.write")) return;
    if (em && !em[2] && M === "PUT") {
      for (const k of ["name", "safeForThirdParties", "passGithub", "passSecrets", "passSandboxCredentials", "passAgentsCredentials", "envContents", "secretFiles"]) if (body && k in body) Object.assign(e, { [k]: body[k] });
      e.latestVersionId = crypto.randomUUID();
      return send(200, { success: true, environment: { ...e } });
    }
    if (em && !em[2] && M === "DELETE") {
      if ([...boxes.values()].some((s) => s.environment === e.name)) return no(409, "environment_in_use", "A sandbox uses it.");
      environments.delete(e.id);
      return send(200, { success: true });
    }
    if (em && em[3]) {
      // One variable, set or removed: the environment's .env-style text keeps the rest.
      const name = decodeURIComponent(em[3]);
      const lines = e.envContents.split("\n").filter((l) => l && !l.startsWith(`${name}=`));
      if (M === "PUT") lines.push(`${name}=${JSON.stringify(String(body?.value ?? ""))}`);
      else if (M !== "DELETE") return no(404, "not_found", "No such endpoint");
      e.envContents = lines.join("\n");
      e.latestVersionId = crypto.randomUUID();
      return send(200, { success: true });
    }
    if (em && em[2] === "/upgrade" && M === "POST") e.upgraded = (e.upgraded || 0) + 1;
    if (em && em[2] === "/upgrade" && M === "POST") return send(200, { success: true, upgraded: [...boxes.values()].filter((s) => s.environment === e.name).length });
    no(404, "not_found", "No such endpoint");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`, key, calls, sandboxes: boxes, snapshots, environments, files, usage, set: (o: Partial<BoatOpts>) => Object.assign(opts, o), close: () => new Promise((r) => server.close(r)) };
}
