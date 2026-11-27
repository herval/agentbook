// exe.dev, as a connector: your own exe.dev account, where agentbook makes machines for you.
// Each is a VM of yours that installs agentbook and joins your agentbook account through the relay, as
// `agentbook login` does on any machine, so it never has to reach this server. agentbook also wakes one that's paused
// when something waits for it (cloud.ts), and deletes one with its machine. It fills no Tasks and answers no
// dashboards. The token stays on the server, never on a VM.
//
// exe.dev's API is its SSH commands (exe.dev/docs/api), sent over HTTPS: POST /exec with the command as the body and
// the token as a bearer token, answered in JSON. A command run on a VM is `ssh <vm> "<command>"`, whose output and exit
// code come back as NDJSON (exe.dev/docs/https-api-run-on-vm). There's no stdin, and a body is 64 KB at most.
// AGENTBOOK_EXE_API_URL points elsewhere (the tests' stand-in).

import type { KindField } from "../connectors.ts";
import type { Sandbox } from "./boat.ts";

export const kind = "exe";
export const name = "exe.dev";
export const STATES: Record<string, string> = {};
export const DEFAULT_STATES: string[] = [];
export const OPTIONAL = true;
export const machines = true;
export const KEY = "API token";
// The commands agentbook runs with a token. `ssh` and `rm` aren't in a token's default list, so the command that
// makes one names them all.
export const SCOPES = ["whoami", "ls", "new", "rm", "pause", "resume", "ssh"];
export const TOKEN_COMMAND = `ssh exe.dev ssh-key generate-api-key --label=agentbook --cmds=${SCOPES.join(",")}`;
export const ABOUT = `Your exe.dev account. agentbook makes machines on it, each a VM of yours that installs agentbook and joins your account, wakes one that's paused, and deletes one with its machine. Make a token with: ${TOKEN_COMMAND}`;
export const FIELDS: Record<string, KindField & { hint?: string; unit?: string }> = {};
export const SIZES: string[] = [];

const API = () => (process.env.AGENTBOOK_EXE_API_URL || "https://exe.dev").replace(/\/$/, "");
// A VM's name as exe.dev takes it, and as agentbook makes them: a machine's name (machineName) fits.
export const VM_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
// What may go inside the double quotes of `ssh <vm> "…"`: nothing exe.dev's command line or the VM's shell would
// read as something else there. What needs more goes as base64 (writeFile).
const PLAIN = /^[^"\\$`\n]*$/;

// Why exe.dev said no, by HTTP status (exe.dev/docs/https-api): `what` was asked of it, with `cmd`.
const WHY: Record<number, (what: string, cmd: string, said: string) => string> = {
  401: () => "exe.dev doesn't take this token any more: it ran out, or was taken back. Paste a new one on Connectors.",
  403: (what, cmd) => `This exe.dev token isn't allowed to ${what}: it needs ${cmd} in its --cmds. Make one with ${TOKEN_COMMAND}`,
  404: (what, cmd) => `exe.dev doesn't know the command ${cmd}.`,
  413: () => "That was more than exe.dev takes in one command (64 KB).",
  429: () => "exe.dev says too many requests for now.",
  504: (what) => `exe.dev took too long to ${what}.`,
};
const LATER = new Set([429, 502, 503, 504]);

interface ExecOptions {
  what?: string;
  timeoutMs?: number;
  ndjson?: boolean;
}
async function post(token: string, command: string, { what = "do that", timeoutMs = 30e3, ndjson = false }: ExecOptions): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${API()}/exec`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "text/plain", accept: ndjson ? "application/x-ndjson" : "application/json" }, body: command, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw Object.assign(new Error(`Can't reach exe.dev (${e.name === "TimeoutError" ? "it took too long" : e.cause?.code || e.message}).`), { later: true });
  }
  if (res.ok) return res;
  const text = (await res.text().catch(() => "")).trim();
  let said = text;
  try {
    const j = JSON.parse(text);
    said = String(j.error || j.message || text);
  } catch {}
  said = said.slice(0, 300);
  const cmd = command.split(" ")[0];
  const message = WHY[res.status] ? WHY[res.status](what, cmd, said) : said ? `exe.dev said: ${said}` : `exe.dev answered HTTP ${res.status}.`;
  throw Object.assign(new Error(message), { status: res.status, later: LATER.has(res.status), said, retry: Number(res.headers.get("retry-after")) || null });
}
// A command on exe.dev itself (ls, new, rm, …): what it answers, as JSON.
async function exec<T = Record<string, unknown>>(token: string, command: string, opts: ExecOptions = {}): Promise<T> {
  const res = await post(token, command, opts);
  const text = await res.text();
  try {
    return (text.trim() ? JSON.parse(text) : {}) as T;
  } catch {
    return { text } as T;
  }
}

// A command run on a VM, as its login user, in their home: its output, and how it ended (`code`: its exit status,
// null when exe.dev cut it off). `command` is put in double quotes, so it may hold none of " \ $ ` (PLAIN).
export interface Ran {
  out: string;
  err: string;
  code: number | null;
}
export async function run(token: string, vm: string, command: string, { what = "run a command on it", timeoutMs = 60e3 }: { what?: string; timeoutMs?: number } = {}): Promise<Ran> {
  if (!VM_NAME.test(vm)) throw new Error(`${vm} isn't an exe.dev VM's name.`);
  if (!PLAIN.test(command)) throw new Error("A command for a VM can't hold \" \\ $ or ` here: send it as base64.");
  const res = await post(token, `ssh ${vm} "${command}"`, { what, timeoutMs, ndjson: true });
  const text = await res.text();
  const out: string[] = [];
  const err: string[] = [];
  let code: number | null = null;
  let cut: string | null = null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let m: { stdout?: string; stderr?: string; exit_code?: number; error?: string };
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof m.stdout === "string") out.push(Buffer.from(m.stdout, "base64").toString("utf8"));
    if (typeof m.stderr === "string") err.push(Buffer.from(m.stderr, "base64").toString("utf8"));
    if (typeof m.exit_code === "number") code = m.exit_code;
    if (m.error) cut = String(m.error);
  }
  if (cut && code == null) throw Object.assign(new Error(`exe.dev cut off the command on ${vm}: ${cut.slice(0, 200)}`), { later: true });
  return { out: out.join(""), err: err.join(""), code };
}

// Who the token signs in as, to show on the Connectors page.
export async function check(token: string): Promise<string> {
  const me = await exec<{ email?: string; user?: string; name?: string; text?: string }>(token, "whoami", { what: "say who you are" });
  return me.email || me.user || me.name || (me.text || "").trim().split("\n")[0].slice(0, 80) || "exe.dev";
}

/* ---------- VMs ---------- */

// A VM as exe.dev says it (`ls --json`, `new --json`).
interface ExeVm {
  vm_name?: string;
  name?: string;
  status?: string;
  ssh_dest?: string;
  https_url?: string;
  region?: string;
  tags?: string[] | null;
}
// As agentbook shows any provider's machine (boat.ts's Sandbox). `state`: "on", "starting", "stopped" (paused), or
// exe.dev's word for it.
const ON = new Set(["running"]);
const STOPPED = new Set(["paused", "stopped", "suspended"]);
const STARTING = new Set(["creating", "starting", "booting", "resuming", "pending", "provisioning"]);
const vmOf = (v: ExeVm): Sandbox => {
  const s = String(v.status || "").toLowerCase();
  return { id: String(v.vm_name || v.name), name: String(v.vm_name || v.name), state: ON.has(s) ? "on" : STOPPED.has(s) ? "stopped" : STARTING.has(s) ? "starting" : s || "unknown", gone: false, size: null, labels: Object.fromEntries((v.tags || []).map((t) => [String(t), "true"])), setup: null, setup_error: null };
};
const vmsIn = (out: { vms?: ExeVm[] } | ExeVm[]): ExeVm[] => (Array.isArray(out) ? out : out.vms || []).filter((v) => v && (v.vm_name || v.name));

export async function sandboxes(token: string): Promise<Sandbox[]> {
  return vmsIn(await exec<{ vms?: ExeVm[] }>(token, "ls --json", { what: "list your VMs" })).map(vmOf);
}
// One VM, by its name. exe.dev not having it is a 404, as boat's is, so it reads as gone (cloud.ts's tend).
export async function sandbox(token: string, id: string): Promise<Sandbox> {
  const v = vmsIn(await exec<{ vms?: ExeVm[] }>(token, "ls --json", { what: "list your VMs" })).find((x) => (x.vm_name || x.name) === id);
  if (!v) throw Object.assign(new Error(`exe.dev has no VM called ${id} on this account. It may have been deleted there.`), { status: 404 });
  return vmOf(v);
}
// Make a VM from exe.dev's own image (exeuntu, which has Claude Code and Codex), tagged as agentbook's. exe.dev
// answers once it's up, which takes up to 9 minutes by its limits.
export async function create(token: string, { name, tag = "agentbook" }: { name: string; tag?: string }): Promise<Sandbox> {
  if (!VM_NAME.test(name)) throw new Error(`${name} can't be an exe.dev VM's name: lowercase letters, digits and -.`);
  const out = await exec<ExeVm & { vm?: ExeVm; vms?: ExeVm[] }>(token, `new --name=${name} --tag=${tag} --json`, { what: "make a VM", timeoutMs: 600e3 });
  const v = out.vm || vmsIn(out)[0] || out;
  return vmOf({ vm_name: name, status: "running", ...v });
}
export async function resume(token: string, id: string): Promise<true> {
  await exec(token, `resume ${id}`, { what: "wake it", timeoutMs: 120e3 });
  return true;
}
export async function stop(token: string, id: string): Promise<true> {
  await exec(token, `pause ${id}`, { what: "pause it", timeoutMs: 120e3 });
  return true;
}
// Delete a VM for good, with its disk. One exe.dev doesn't have any more is deleted already.
export async function remove(token: string, id: string): Promise<true> {
  try {
    await exec(token, `rm ${id}`, { what: "delete it", timeoutMs: 120e3 });
  } catch (e) {
    if (e.status !== 404 && !/not found|no such/i.test(e.said || "")) throw e;
  }
  return true;
}

/* ---------- files on a VM, over ssh ---------- */

// Write a file under the VM's home (or anywhere its user can), in one command: its content goes as base64.
export async function writeFile(token: string, vm: string, path: string, content: string, { mode = "600" }: { mode?: string } = {}): Promise<void> {
  if (!PLAIN.test(path) || /\s/.test(path)) throw new Error(`${path} can't be a file's path here.`);
  const b64 = Buffer.from(content, "utf8").toString("base64");
  const r = await run(token, vm, `umask 077 && echo ${b64} | base64 -d > ${path} && chmod ${mode} ${path}`, { what: "write a file on it" });
  if (r.code !== 0) throw new Error(`Couldn't write ${path} on ${vm}: ${(r.err || r.out).trim().slice(0, 200) || `exit ${r.code}`}`);
}
// A text file on the VM: its text, or null when it isn't there.
export async function readFile(token: string, vm: string, path: string): Promise<string | null> {
  if (!PLAIN.test(path) || /\s/.test(path)) throw new Error(`${path} can't be a file's path here.`);
  const r = await run(token, vm, `cat ${path} 2>/dev/null || echo __agentbook_none__`, { what: "read its log" });
  return r.out.trim() === "__agentbook_none__" ? null : r.out;
}
// Run a script on the VM in the background, detached from this command: it's written to `path`, started with bash,
// and the command comes back at once.
export async function start(token: string, vm: string, path: string, script: string): Promise<void> {
  await writeFile(token, vm, path, script, { mode: "700" });
  const r = await run(token, vm, `setsid nohup bash ${path} </dev/null >/dev/null 2>&1 & echo started`, { what: "start its setup" });
  if (!r.out.includes("started")) throw new Error(`Its setup didn't start on ${vm}: ${(r.err || r.out).trim().slice(0, 200) || `exit ${r.code}`}`);
}
