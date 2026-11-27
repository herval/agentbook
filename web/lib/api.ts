import { sessionEnd, signCommand } from "./passkeys.ts";
import { go, personHref } from "./route.ts";
import { getApp } from "./store.ts";
import { signedOut } from "./session.ts";
import { toast } from "./toast.ts";

export type { Reply, Said } from "../../plugin/shared/api.ts";
import { queryUrl } from "../../plugin/shared/api.ts";
import type { LiveWatchRequest, QueryInput, QueryPath, QueryResponse, Reply, Said } from "../../plugin/shared/api.ts";

// A GET's answer, or null when it failed (a 401 also signs the page out).
export async function getJSON<T = unknown>(url: string, opts?: RequestInit): Promise<T | null> {
  const res = await fetch(url, opts);
  if (res.status === 401) signedOut();
  return res.ok ? res.json() : null;
}

// Queries use one contract for their path, parameters and answer on both sides.
export function query<P extends QueryPath>(path: P, input: QueryInput<P>, opts?: RequestInit): Promise<QueryResponse<P> | null> {
  return getJSON<QueryResponse<P>>(queryUrl(path, input), opts);
}

// Leaving a screen drops its watch without blocking navigation or showing a toast.
export function dropWatch(body: LiveWatchRequest): void {
  void fetch("/api/live/watch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => {});
}

// What the server answers, as `T` says of the route (`Said`, what most say, when it's not given). A failure says why
// in a toast.
export async function post<T extends object = Said>(url: string, body?: object): Promise<Reply<T & Said>>;
export async function post(url: string, body?: object): Promise<Reply> {
  let res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  let data: Said = await res.json().catch(() => ({}));
  // A machine of yours that keeps your passkeys takes this only signed: the server says what to sign, and it goes
  // again, with your passkey's signature.
  if (res.status === 428 && data.sign) {
    let sig;
    try {
      sig = await signCommand(data.sign, data.keys, data.session);
    } catch (e) {
      const username = getApp().me?.username;
      toast(e.message, username ? { label: "Manage passkeys", run: () => go(personHref(username, "settings/passkeys")) } : undefined);
      return { ok: false, data: { error: e.message, passkey: true } };
    }
    res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...(body || {}), signed: { envelope: data.sign, sig } }) });
    data = await res.json().catch(() => ({}));
    // A machine that wouldn't take this browser's key (its clock says it ran out, say): the next one asks your passkey.
    if (!res.ok && sig.session && /browser's key/.test(data.error || "")) sessionEnd();
  }
  if (res.status === 401) signedOut();
  else if (!res.ok) toast(data.error || `Something went wrong (HTTP ${res.status})`);
  return { ok: res.ok, data };
}

// Upload a box's attached files as drafts; the message or post they go with picks them up.
// `machine`: for a new post on another machine, its files go there.
export async function sendStaged(files: File[], post: string | null, machine?: string): Promise<string[]> {
  const ids = [];
  for (const f of files) {
    const q = new URLSearchParams({ name: f.name || "pasted.png", draft: "1", ...(post ? { post } : {}), ...(machine ? { machine } : {}) });
    const res = await fetch(`/api/upload?${q}`, { method: "POST", body: f });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Couldn't upload ${f.name}`);
    ids.push(body.id);
  }
  return ids;
}

// Upload a file somewhere (`params` say where); a machine that keeps your passkeys gets it once you sign.
export async function upload(file: File, params: Record<string, string>): Promise<void> {
  const q = new URLSearchParams({ name: file.name || "pasted.png", ...params });
  const res = await fetch(`/api/upload?${q}`, { method: "POST", body: file });
  const body = await res.json().catch(() => ({}));
  if (res.status === 428 && body.sign && body.send) {
    try {
      await post(body.send, { signed: { envelope: body.sign, sig: await signCommand(body.sign, body.keys, body.session) } });
    } catch (e) {
      const username = getApp().me?.username;
      toast(e.message, username ? { label: "Manage passkeys", run: () => go(personHref(username, "settings/passkeys")) } : undefined);
    }
    return;
  }
  if (!res.ok) toast(body.error || "Upload failed");
}

export function pickFile(cb: (f: File) => void, accept?: string): void;
export function pickFile(cb: (f: File[]) => void, multiple: true, accept?: string): void;
export function pickFile(cb: ((f: File) => void) | ((f: File[]) => void), a?: string | boolean, b = ""): void {
  const multiple = a === true;
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = multiple;
  input.accept = typeof a === "string" ? a : b;
  input.addEventListener("change", () => input.files.length && (multiple ? (cb as (f: File[]) => void)([...input.files]) : (cb as (f: File) => void)(input.files[0])));
  input.click();
}

// One request at a time per kind: asking again while one runs queues exactly one more.
export function loader(fn: () => Promise<unknown>): () => Promise<unknown> {
  let running: Promise<unknown> | null = null;
  let again = false;
  return async function run() {
    if (running) return void (again = true);
    running = fn().finally(() => {
      running = null;
      if (again) {
        again = false;
        run();
      }
    });
    return running;
  };
}
