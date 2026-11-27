// boat (boat.dev), as a connector: your own boat account, so this server can wake a machine of yours that runs in
// a boat sandbox. A sandbox stops itself after a while and can't wake
// itself, and what you send its machine waits here meanwhile: with your key, the server resumes it (cloud.ts).
// It fills no Tasks and answers no dashboards. The key stays on the server, never in a sandbox.
//
// boat's API (docs.boat.dev/api/v1): https://boat.dev/api/v1, the key as a bearer token, errors as
// { ok: false, status, code, message }. AGENTBOOK_BOAT_API_URL points elsewhere (the tests' stand-in).

import type { KindField } from "../connectors.ts";

export const kind = "boat";
export const name = "boat";
export const STATES: Record<string, string> = {};
export const DEFAULT_STATES: string[] = [];
export const OPTIONAL = true;
// It wakes machines (cloud.ts): the third thing a kind can do, beside filling Tasks and answering dashboards.
export const machines = true;
export const KEY = "API key";
export const ABOUT = "Your boat.dev account. With a key that has only sandbox.read, sandbox.resume and account.read (boat api-key create), agentbook wakes a machine of yours that runs in a boat sandbox when something waits for it: pick the sandbox on the machine's page. With more, it also puts it to sleep when it's idle, and makes machines for you.";
// Its settings: which wallet pays for what agentbook makes, how
// big a new machine is, how long an idle one stays up, and the longest a busy one runs before boat stops it anyway.
export const SIZES = ["small", "default", "large", "xlarge"];
// A field's `hint` and `unit`: what the page says beside it.
export const FIELDS: Record<string, KindField & { hint?: string; unit?: string }> = {
  org: { default: "personal", label: "Wallet that pays", hint: "personal, or an organization's name as boat org list shows it" },
  size: { of: SIZES, default: "default", label: "Size of a new machine" },
  idle: { of: ["5", "15", "30", "60"], default: "15", label: "An idle machine stops after", unit: "minutes" },
  busy: { of: ["2", "4", "8", "24"], default: "8", label: "A busy one stops anyway after", unit: "hours" },
};
// What agentbook does with a key, and the actions of boat's each needs (docs.boat.dev/api-keys/scopes): a key
// without one still does the rest.
export const NEEDS: Record<string, string[]> = {
  wake: ["sandbox.read", "sandbox.resume"],
  sleep: ["sandbox.update"],
  usage: ["sandbox.read"],
  make: ["sandbox.create", "sandbox.delete-own", "snapshot.read", "environment.read", "environment.write"],
  build: ["sandbox.create", "sandbox.delete-own", "snapshot.read", "snapshot.write", "file.read"],
};
export const SCOPES = [...new Set(Object.values(NEEDS).flat().concat("sandbox.stop", "account.read"))];

const API = () => (process.env.AGENTBOOK_BOAT_API_URL || "https://boat.dev/api/v1").replace(/\/$/, "");
export const SANDBOX_ID = /^bx_[a-z0-9]{6,20}$/;

// Why boat said no, in words that say what to do about it. `what`: what was asked of it ("wake bx_…").
const WHY: Record<string, (what: string, needs: string | null) => string> = {
  unauthorized: () => "boat doesn't take this API key any more. Paste a new one on Connectors.",
  api_key_expired: () => "This boat API key ran out. Paste a new one on Connectors.",
  api_key_action_forbidden: (what, needs) => `This boat API key isn't allowed to ${what}. It needs ${needs || "sandbox.read and sandbox.resume"}.`,
  api_key_sandbox_forbidden: () => "This boat API key doesn't reach that sandbox.",
  not_found: () => "boat has no such sandbox on this account. It may have been deleted.",
  snapshot_data_expired: () => "boat deleted this sandbox's disk: it was stopped for more than 14 days. It can't come back.",
  billing_required: () => "boat won't start it: the plan's hours are used up and the wallet is empty, or the account has no plan.",
  team_member_cap_reached: () => "boat won't start it: you've reached your usage cap in the organization.",
  org_suspended: () => "boat won't start it: the organization's wallet is suspended.",
  trial_compute_limit_reached: () => "boat won't start it: the trial's hours are used up.",
  limit_reached: () => "boat won't start it: as many sandboxes as the plan allows are running. Stop one.",
  member_limit_reached: () => "boat won't start it: you're running as many sandboxes as the organization lets you.",
  rate_limited: () => "boat won't start it yet: too many starts in a short while.",
  trial_auto_stop_required: () => "boat's free trial stops a sandbox after two hours at most.",
  trial_machine_class_not_allowed: () => "boat's free trial has no large machines. Pick default, or end the trial.",
  machine_class_plan_required: () => "That size needs boat's $100 plan or higher.",
  credit_required: () => "boat won't keep another saved snapshot: the plan's included ones are used and the wallet is empty.",
  unknown_environment: () => "boat has no such environment on this account.",
  snapshot_not_found: () => "boat has no such saved snapshot on this account. Build its image again.",
  sandbox_stopping: () => "boat is still stopping it.",
  out_of_capacity: () => "boat is out of machines for the moment.",
  no_ready_machine: () => "boat has no machine ready for the moment.",
};
// Ones worth asking again after a while, by themselves.
const LATER = new Set(["rate_limited", "sandbox_stopping", "out_of_capacity", "no_ready_machine"]);

interface ApiOptions {
  body?: unknown;
  what?: string;
  needs?: string | null;
  headers?: Record<string, string>;
}
// An error, as boat answers one.
interface BoatError {
  code?: string;
  message?: string;
  error?: string | { code?: string; message?: string } | null;
  retryAfterSeconds?: number;
}
// `needs`: the key's action this takes, to name when boat says the key hasn't got it. `headers`: more of them.
// `T`: what the call answers with.
async function api<T = unknown>(key: string, method: string, path: string, { body, what = "do that", needs = null, headers = {} }: ApiOptions = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API()}${path}`, { method, headers: { accept: "application/json", authorization: `Bearer ${key}`, ...(body ? { "content-type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  } catch (e) {
    throw Object.assign(new Error(`Can't reach boat (${e.name === "TimeoutError" ? "it took too long" : e.cause?.code || e.message}).`), { later: true });
  }
  const out = (await res.json().catch(() => ({}))) as T & BoatError;
  if (res.ok) return out;
  const inner = out.error && typeof out.error === "object" ? out.error : null;
  const code = String(out.code || inner?.code || (typeof out.error === "string" ? out.error : "") || "");
  const said = String(out.message || inner?.message || "").slice(0, 200);
  const retry = Number(res.headers.get("retry-after")) || Number(out.retryAfterSeconds) || null;
  throw Object.assign(new Error(WHY[code] ? WHY[code](what, needs) : said ? `boat said: ${said}` : `boat answered HTTP ${res.status}.`), { code: code || null, status: res.status, later: LATER.has(code) || res.status >= 500, retry });
}

// Who the key signs in as, to show on the Connectors page. A key without account.read still reads sandboxes, which
// is all waking needs.
export async function check(key: string, conf: { settings?: Record<string, string> } = {}): Promise<string> {
  await api(key, "GET", "/sandboxes?limit=1", { what: "read your sandboxes" });
  // A wallet other than your own: one boat knows, by its name or id (a key without account.read can't ask).
  const org = String(conf.settings?.org || "personal").trim();
  if (org && org.toLowerCase() !== "personal") {
    let orgs: { id: string; name?: string; type?: string }[] | null = null;
    try {
      orgs = (await api<{ orgs?: { id: string; name?: string; type?: string }[] }>(key, "GET", "/orgs")).orgs || [];
    } catch (e) {
      if (e.code !== "api_key_action_forbidden") throw e;
    }
    if (orgs && !orgs.some((o) => o.id === org || String(o.name || "").toLowerCase() === org.toLowerCase())) throw new Error(`Your boat account is in no organization called ${org}. ${orgs.filter((o) => o.type === "org").length ? `It's in ${orgs.filter((o) => o.type === "org").map((o) => o.name).join(", ")}.` : "It's in none: leave the wallet as personal."}`);
  }
  try {
    const me = (await api<{ user?: { login?: string; email?: string; displayName?: string } }>(key, "GET", "/me")).user;
    return me?.login || me?.email || me?.displayName || "boat";
  } catch {
    return "boat";
  }
}

// What the key can't be seen to do, as boat's action names ([] when it reads all agentbook reads). boat doesn't say
// what a key may do, so this asks for what only reads: its sandboxes, saved snapshots, environments and account. The
// actions that change something (create, update, resume, delete) say so when they're first needed.
const READS = [
  ["sandbox.read", "/sandboxes?limit=1"],
  ["snapshot.read", "/saved-snapshots?limit=1"],
  ["environment.read", "/environments"],
  ["account.read", "/me"],
];
export async function lacks(key: string): Promise<string[]> {
  const out = await Promise.all(
    READS.map(([scope, path]) =>
      api(key, "GET", path).then(
        (): null => null,
        (e) => (e.code === "api_key_action_forbidden" || e.code === "api_key_sandbox_forbidden" ? scope : null),
      ),
    ),
  );
  return out.filter(Boolean);
}

// A sandbox as agentbook shows it: { id, name, state, on }. boat calls a stopped one "archived".
const ON = new Set(["ready", "idle", "running"]);
const STARTING = new Set(["init", "provisioning", "provisioned", "cloning"]);
// A sandbox as boat says it.
interface BoatSandbox {
  id: string;
  name?: string | null;
  state?: string;
  type?: string | null;
  labels?: Record<string, string> | null;
  setupStatus?: string | null;
  setupError?: string | null;
  dataExpiredAt?: string | null;
}
// A sandbox as agentbook shows it. `state`: "on", "starting", "stopped" or boat's word for it; `gone`: its disk was
// deleted (stopped over 14 days).
export interface Sandbox {
  setup: string | null;
  setup_error: string | null;
  size: string | null;
  labels: Record<string, string>;
  id: string;
  name: string | null;
  state: string;
  gone: boolean;
}
// `setup`: how its setup script is going ("pending", "running", "done", "failed"; null when it has none).
const sandboxOf = (s: BoatSandbox): Sandbox => ({ setup: s.setupStatus || null, setup_error: s.setupError ? String(s.setupError).slice(0, 2000) : null, size: s.type || null, labels: s.labels || {}, id: String(s.id), name: s.name ? String(s.name).slice(0, 80) : null, state: ON.has(s.state) ? "on" : STARTING.has(s.state) ? "starting" : s.state === "archived" || s.state === "archiving" ? "stopped" : String(s.state || "unknown"), gone: !!s.dataExpiredAt });

// The account's sandboxes, running or stopped (not the ones a create never finished).
export async function sandboxes(key: string): Promise<Sandbox[]> {
  const out = await api<{ sandboxes?: BoatSandbox[] }>(key, "GET", "/sandboxes?limit=200&state=provisioning,provisioned,cloning,ready,idle,running,archiving,archived", { what: "read your sandboxes" });
  return (out.sandboxes || []).filter((s) => s?.id).map(sandboxOf);
}
export async function sandbox(key: string, id: string): Promise<Sandbox> {
  const out = await api<BoatSandbox & { sandbox?: BoatSandbox }>(key, "GET", `/sandboxes/${encodeURIComponent(id)}`, { what: "read that sandbox" });
  return sandboxOf(out.sandbox || out);
}
// Wake a stopped sandbox. boat answers once it has started resuming; its machine connects by itself a few seconds on.
export async function resume(key: string, id: string): Promise<true> {
  await api(key, "POST", `/sandboxes/${encodeURIComponent(id)}/resume`, { what: "wake it" });
  return true;
}

// boat stops a running sandbox `seconds` from now (its auto-stop, which counts from this call): how agentbook puts a
// machine to sleep once it's idle, and keeps a busy one up (cloud.ts, "Sleeping").
// -> { seconds }: what boat took, which is less than asked on its free trial (two hours at most there).
const TRIAL_MAX = 7200;
export async function stopIn(key: string, id: string, seconds: number): Promise<{ seconds: number }> {
  const ask = (s: number) => api(key, "PATCH", `/sandboxes/${encodeURIComponent(id)}`, { body: { ttlSeconds: s }, what: "say when its sandbox stops", needs: "sandbox.update" });
  const want = Math.max(60, Math.round(seconds));
  try {
    await ask(want);
    return { seconds: want };
  } catch (e) {
    if (e.code !== "trial_auto_stop_required" || want <= TRIAL_MAX) throw e;
    await ask(TRIAL_MAX);
    return { seconds: TRIAL_MAX };
  }
}
// The machine time a sandbox used since `since` (an ISO time; none: since it was made), and what that costs at
// boat's list price: { seconds, dollars, running, size }.
export interface Usage {
  seconds: number;
  dollars: number;
  running: boolean;
  size: string | null;
  since: string | null;
}
export async function usage(key: string, id: string, since: string | null = null): Promise<Usage> {
  const out = await api<{ seconds?: number; dollars?: number; running?: boolean; sandboxType?: string | null; since?: string | null }>(key, "GET", `/sandboxes/${encodeURIComponent(id)}/usage${since ? `?since=${encodeURIComponent(since)}` : ""}`, { what: "read its usage" });
  return { seconds: Number(out.seconds) || 0, dollars: Number(out.dollars) || 0, running: !!out.running, size: out.sandboxType || null, since: out.since || since };
}
// The wallet a connector's machines bill (`org`: "personal", or an organization): what's left of the plan's hours
// this period, the money in the wallet, and whether boat would start a machine now.
// What boat says of a wallet (GET /limits).
interface Limits {
  canStart?: boolean;
  sandboxPlanDollars?: number | null;
  planIncluded?: { vmHours?: number | null; vmHoursRemaining?: number | null; periodEnd?: string | null } | null;
  wallet?: { balanceDollars?: number | null } | null;
  overagePrices?: { vmHourDollars?: number | null } | null;
  giftLimit?: { maxTtlSeconds?: number | null } | null;
}
export async function wallet(key: string, org = "personal") {
  const out = await api<Limits>(key, "GET", `/limits${org && org.toLowerCase() !== "personal" ? `?org=${encodeURIComponent(org)}` : ""}`, { what: "read your plan", needs: "account.read" });
  return {
    can_start: out.canStart !== false,
    plan_dollars: out.sandboxPlanDollars ?? null,
    hours: out.planIncluded?.vmHours ?? null,
    hours_left: out.planIncluded?.vmHoursRemaining ?? null,
    period_end: out.planIncluded?.periodEnd || null,
    balance: out.wallet?.balanceDollars ?? null,
    hour_dollars: out.overagePrices?.vmHourDollars ?? null,
    max_stop_seconds: out.giftLimit?.maxTtlSeconds ?? null,
  };
}

/* ---------- making, stopping and deleting sandboxes ---------- */

// Make a sandbox. `from`: a saved snapshot's name. `script`: a setup script, which runs once it's up (its state is
// then in the sandbox's `setup`). `files`: [{ path, content }], written before it's ready. `environment`: the boat
// environment whose secrets it gets, or `bare` for none of the account's. `stopIn`: seconds until boat stops it.
// `idempotency`: the same one gets the same sandbox, so a retry never makes (or bills) a second.
export interface CreateOptions {
  name?: string;
  size?: string;
  from?: string | null;
  script?: string;
  files?: { path: string; content: string }[];
  environment?: string | null;
  bare?: boolean;
  stopIn?: number;
  labels?: Record<string, string>;
  org?: string | null;
  monitoring?: boolean;
}
export async function create(key: string, { name, size, from, script, files, environment, bare = false, stopIn: ttl = 3600, labels, org, monitoring = false }: CreateOptions = {}, { idempotency }: { idempotency?: string } = {}): Promise<Sandbox> {
  const body = {
    ...(name ? { name: String(name).slice(0, 120) } : {}),
    ...(size ? { type: size } : {}),
    ...(from ? { from } : {}),
    ...(script ? { setupScript: script } : {}),
    ...(files?.length ? { files } : {}),
    ...(bare ? { noEnv: true } : environment ? { environment } : {}),
    ttlSeconds: ttl,
    ...(labels ? { labels } : {}),
    ...(org && String(org).toLowerCase() !== "personal" ? { org } : {}),
    monitoring,
  };
  const ask = (b: typeof body) => api<BoatSandbox & { sandbox?: BoatSandbox }>(key, "POST", "/sandboxes", { body: b, what: "make a sandbox", needs: from ? "sandbox.create and snapshot.read" : "sandbox.create", headers: idempotency ? { "idempotency-key": idempotency } : {} });
  let out: BoatSandbox & { sandbox?: BoatSandbox };
  try {
    out = await ask(body);
  } catch (e) {
    // The free trial: two hours at most, which agentbook's own auto-stop moves anyway.
    if (e.code !== "trial_auto_stop_required" || ttl <= TRIAL_MAX) throw e;
    out = await ask({ ...body, ttlSeconds: TRIAL_MAX });
  }
  return sandboxOf(out.sandbox || out);
}
export async function stop(key: string, id: string): Promise<true> {
  await api(key, "POST", `/sandboxes/${encodeURIComponent(id)}/stop`, { body: {}, what: "stop it", needs: "sandbox.stop" });
  return true;
}
// Delete a sandbox for good: its machine, its disk and its snapshots. A saved snapshot made from it stays.
export async function remove(key: string, id: string): Promise<true> {
  try {
    await api(key, "DELETE", `/sandboxes/${encodeURIComponent(id)}`, { what: "delete it", needs: "sandbox.delete-own (or sandbox.delete, for one this key didn't make)", headers: { "x-ascii-confirm-delete": id } });
  } catch (e) {
    if (e.code !== "not_found" && e.status !== 404) throw e;
  }
  return true;
}
// The sandboxes agentbook made here: the ones with this label ({ key: value }).
export async function labelled(key: string, labels: Record<string, string>): Promise<Sandbox[]> {
  const q = Object.entries(labels).map(([k, v]) => `label=${encodeURIComponent(`${k}=${v}`)}`).join("&");
  const out = await api<{ sandboxes?: BoatSandbox[] }>(key, "GET", `/sandboxes?limit=200&${q}`, { what: "read your sandboxes" });
  return (out.sandboxes || []).filter((s) => s?.id).map(sandboxOf);
}
// A text file on a sandbox, under its home (5 MB at most): its text, or null when it isn't there.
export async function readFile(key: string, id: string, path: string): Promise<string | null> {
  try {
    const out = await api<{ content?: string; encoding?: string }>(key, "GET", `/sandboxes/${encodeURIComponent(id)}/files?path=${encodeURIComponent(path)}`, { what: "read its log", needs: "file.read" });
    return typeof out.content === "string" ? (out.encoding === "base64" ? Buffer.from(out.content, "base64").toString("utf8") : out.content) : null;
  } catch (e) {
    if (e.status === 404 || e.code === "file_not_found" || e.code === "not_found") return null;
    throw e;
  }
}

/* ---------- saved snapshots: what an image's version is, on boat ---------- */

// A saved snapshot as boat says it, and as agentbook shows it (`state`: "ready", "failed" or "saving").
interface BoatSnapshot {
  name: string;
  status?: string;
  error?: string | null;
  type?: string | null;
  sizeBytes?: number | null;
}
export interface Snapshot {
  name: string;
  state: "ready" | "failed" | "saving";
  error: string | null;
  size: string | null;
  bytes: number | null;
}
const snapOf = (s: BoatSnapshot): Snapshot => ({ name: String(s.name), state: s.status === "ready" ? "ready" : s.status === "failed" ? "failed" : "saving", error: s.error ? String(s.error).slice(0, 500) : null, size: s.type || null, bytes: s.sizeBytes ?? null });
// Freeze a sandbox's disk under a name. boat answers at once; it's "saving" until `snapshot` says ready or failed.
export async function saveSnapshot(key: string, sandbox: string, name: string): Promise<Snapshot> {
  const out = await api<{ snapshot?: BoatSnapshot; status?: string }>(key, "POST", "/saved-snapshots", { body: { sandboxId: sandbox, name }, what: "save its disk", needs: "snapshot.write" });
  return snapOf(out.snapshot || { name, status: out.status || "saving" });
}
// null: boat has none by that name.
export async function snapshot(key: string, name: string): Promise<Snapshot | null> {
  try {
    const out = await api<BoatSnapshot & { snapshot?: BoatSnapshot }>(key, "GET", `/saved-snapshots/${encodeURIComponent(name)}`, { what: "read a saved snapshot", needs: "snapshot.read" });
    return snapOf(out.snapshot || out);
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}
export async function dropSnapshot(key: string, name: string): Promise<true> {
  try {
    await api(key, "DELETE", `/saved-snapshots/${encodeURIComponent(name)}`, { what: "delete a saved snapshot", needs: "snapshot.write" });
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  return true;
}

/* ---------- environments: where a machine's secrets live, on boat ---------- */

// boat's environments, briefly: [{ id, name }].
// An environment as boat says it.
interface BoatEnvironment {
  id: string;
  name: string;
}
export async function environments(key: string): Promise<{ id: string; name: string }[]> {
  const out = await api<{ environments?: BoatEnvironment[] }>(key, "GET", "/environments", { what: "read your environments", needs: "environment.read" });
  return (out.environments || []).map((e) => ({ id: String(e.id), name: String(e.name) }));
}
// An environment of its own for one machine, by name, that passes it nothing of the account's (no GitHub, no boat
// credentials, no agent logins) but `vars`: its settings and secrets, as { NAME: value }. Made if it isn't there,
// and its contents replaced whole. -> its id. boat keeps the values; agentbook never does.
export async function setEnvironment(key: string, name: string, vars: Record<string, unknown> = {}): Promise<string> {
  const needs = "environment.read and environment.write";
  let id = (await environments(key)).find((e) => e.name === name)?.id;
  if (!id) {
    const out = await api<{ environments?: BoatEnvironment[]; environment?: BoatEnvironment }>(key, "POST", "/environments", { body: { name }, what: "make its environment", needs });
    id = (out.environments || []).find((e) => e.name === name)?.id || out.environment?.id;
    if (!id) throw new Error("boat made the environment but didn't say which it is.");
  }
  const envContents = Object.entries(vars).map(([k, v]) => `${k}=${JSON.stringify(String(v))}`).join("\n");
  await api(key, "PUT", `/environments/${encodeURIComponent(id)}`, { body: { safeForThirdParties: false, passGithub: false, passSecrets: true, passSandboxCredentials: false, passAgentsCredentials: false, envContents }, what: "set its secrets", needs });
  // Sandboxes stay on the version they started with until they're upgraded.
  await api(key, "POST", `/environments/${encodeURIComponent(id)}/upgrade`, { body: {}, what: "give its sandbox the new secrets", needs }).catch(() => {});
  return id;
}
export async function dropEnvironment(key: string, id: string): Promise<true> {
  try {
    await api(key, "DELETE", `/environments/${encodeURIComponent(id)}`, { what: "delete its environment", needs: "environment.write" });
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  return true;
}
// One secret of an environment, set or taken away without reading or rewriting the rest (agentbook keeps no values,
// so it couldn't rewrite them), then given to the sandboxes that use the environment.
export async function setSecret(key: string, env: string, name: string, value: unknown): Promise<true> {
  const needs = "environment.write";
  if (value == null) {
    await api(key, "DELETE", `/environments/${encodeURIComponent(env)}/vars/${encodeURIComponent(name)}`, { what: "take its secret away", needs }).catch((e) => {
      if (e.status !== 404) throw e;
    });
  } else await api(key, "PUT", `/environments/${encodeURIComponent(env)}/vars/${encodeURIComponent(name)}`, { body: { value: String(value) }, what: "set its secret", needs });
  await api(key, "POST", `/environments/${encodeURIComponent(env)}/upgrade`, { body: {}, what: "give its sandbox the new secrets", needs }).catch(() => {});
  return true;
}
