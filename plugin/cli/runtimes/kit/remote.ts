// What the runtimes of agents that run on someone else's computers share (Claude Agent, Devin): a key kept on this
// machine and nowhere else, their HTTP APIs, their event streams, the repo a thread of theirs works in, and their row
// on Add agents.

import fs from "node:fs";
import path from "node:path";
import { HOME } from "../../../lib/common.ts";
import { prOfUrl, prUrl } from "../../../shared/prs.ts";
import type { RuntimeContext, RuntimeRow } from "../runtime.ts";

// A file only this user can read, in the CLI's folder: { key, … }. Its key never goes up to the server, and nothing
// gives it back out.
export interface Kept {
  key?: string;
  // Devin's organization.
  org?: string;
  github_token?: string;
  // What a thread may spend: Claude Agent's in dollars, Devin's in ACUs.
  budget?: number | null;
  // Claude Agent's agent, environment and vault, made once for its threads.
  agent_id?: string;
  environment_id?: string;
  vault_id?: string;
}
export function keptFile(name: string) {
  const file = () => path.join(HOME, "cli", `${name}.json`);
  return {
    read(): Kept {
      try {
        return JSON.parse(fs.readFileSync(file(), "utf8")) || {};
      } catch {
        return {};
      }
    },
    write(c: Kept) {
      fs.mkdirSync(path.dirname(file()), { recursive: true });
      fs.writeFileSync(file(), JSON.stringify(c, null, 1) + "\n", { mode: 0o600 });
      fs.chmodSync(file(), 0o600);
    },
  };
}

// An error with the HTTP status it's answered with (a vendor's refusal, or what agentbook says back).
export interface StatusError extends Error {
  status?: number;
}

// What a vendor's API said when it refused, in its own words when it has any.
const said = (j, text: string) => j?.error?.message || (typeof j?.error === "string" ? j.error : null) || (typeof j?.detail === "string" ? j.detail : null) || j?.message || text.slice(0, 200);
export function refusal(name: string, status: number, body: string) {
  let j = null;
  try {
    j = JSON.parse(body);
  } catch {}
  const why = said(j, body).trim();
  const e: StatusError = new Error(status === 401 || status === 403 ? `${name} refused the key${why ? `: ${why}` : ""}` : `${name} said ${status}${why ? `: ${why}` : ""}`);
  e.status = status;
  return e;
}

// One call to a vendor's API. -> its JSON (or `raw`, its bytes). A call that gets no answer in time fails rather than
// hold up what's waiting on it. `body` goes as JSON; `form`, as it is (a multipart upload).
export interface CallOpts {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  form?: FormData;
  raw?: boolean;
  timeout?: number;
}
export async function callApi(name: string, url: string, { method = "GET", headers = {}, body, form, raw = false, timeout = 30e3 }: CallOpts = {}) {
  const r = await fetch(url, {
    method,
    headers: { ...headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: form || (body !== undefined ? JSON.stringify(body) : undefined),
    signal: AbortSignal.timeout(timeout),
  }).catch((e) => {
    throw new Error(`Can't reach ${name}: ${e.cause?.message || e.message}`);
  });
  if (!r.ok) throw refusal(name, r.status, await r.text().catch(() => ""));
  if (raw) return Buffer.from(await r.arrayBuffer());
  const text = await r.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${name} answered with something that isn't JSON.`);
  }
}

// A vendor's server-sent events, opened: its answer is in once this returns, so nothing after this moment is missed.
// -> an async iterable of each event's JSON.
export async function openEvents(name: string, url: string, { headers = {}, signal }: { headers?: Record<string, string>; signal?: AbortSignal } = {}) {
  const r = await fetch(url, { headers: { ...headers, accept: "text/event-stream" }, signal });
  if (!r.ok) throw refusal(name, r.status, await r.text().catch(() => ""));
  return readEvents(r.body, signal);
}
// A connection that died with no goodbye (this machine slept) stays quiet forever, so one quiet this long is given
// up on: whoever reads it opens another and reads what it missed, which costs little if nothing was wrong.
const QUIET_MS = 120e3;
export async function* readEvents(body: ReadableStream<Uint8Array>, signal?: AbortSignal, quietMs = QUIET_MS) {
  const decoder = new TextDecoder();
  let held = "";
  let data = [];
  const reader = body.getReader();
  const next = () => {
    let timer;
    const quiet = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error("Its stream went quiet."), { quiet: true })), quietMs);
    });
    return Promise.race([reader.read(), quiet]).finally(() => clearTimeout(timer));
  };
  try {
    for (;;) {
      const { value, done } = await next();
      if (done || signal?.aborted) return;
      held += decoder.decode(value, { stream: true });
      let at;
      while ((at = held.indexOf("\n")) >= 0) {
        const line = held.slice(0, at).replace(/\r$/, "");
        held = held.slice(at + 1);
        if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        else if (!line && data.length) {
          const text = data.join("\n");
          data = [];
          try {
            yield JSON.parse(text);
          } catch {} // a keep-alive of some kind, not an event
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

// A GitHub repo however it's written, as the post's repo key ("github.com/owner/name") or a URL, an SSH remote or
// "owner/name": -> { key, owner, name, url }, or null for anything else.
export interface GithubRepo {
  key: string;
  owner: string;
  name: string;
  url: string;
}
export function githubRepo(repo: string | null | undefined): GithubRepo | null {
  const m = String(repo || "")
    .trim()
    .replace(/\.git$/, "")
    .replace(/\/+$/, "")
    .match(/^(?:(?:https?:\/\/|ssh:\/\/git@|git@)?(?:www\.)?github\.com[/:])?([\w.-]+)\/([\w.-]+)$/i);
  if (!m) return null;
  const [, owner, name] = m;
  return { key: `github.com/${owner}/${name}`, owner, name, url: `https://github.com/${owner}/${name}` };
}

// A pull request its vendor says it opened (the first link in `text`), on its post now. Said twice, it's the same one.
export function linkPr(ctx: Pick<RuntimeContext, "emit">, post: string, text: string, at: string) {
  const pr = prOfUrl(text);
  if (pr) ctx.emit({ e: "fact", op: { t: "session.pr", post, url: prUrl(pr.repo, pr.number), number: pr.number, repo: pr.repo, how: "opened", at } });
}

// A file you attached, as the core's delivery hands it on (an answer's, a message's or one you sent by itself) or as a
// start has it: its name, and where it is here.
export interface Attached {
  name?: string;
  path: string;
}
// A thread's files as bytes, for a vendor that keeps its own copy: those it can read, and the names of those it can't.
export function filesOn(files: Attached[]) {
  const ready = [];
  const missed = [];
  for (const f of files || []) {
    try {
      ready.push({ name: f.name || path.basename(f.path), bytes: fs.readFileSync(f.path) });
    } catch {
      missed.push(f.name || path.basename(String(f.path)));
    }
  }
  return { ready, missed };
}

// Waits between tries at something that keeps failing, growing up to `most`.
export const backoff = (first = 1000, most = 60e3) => {
  let wait = first;
  return {
    next: () => new Promise((r) => {
      const t = setTimeout(r, wait);
      t.unref?.();
      wait = Math.min(wait * 2, most);
    }),
    reset: () => void (wait = first),
  };
};

// The env var that leaves a runtime off here ("<name>=0"), of the names it goes by (its own first, then one it had
// before, still read so a machine set up with it stays as it was), or null while it's on. The first one set decides.
export function offBy(...flags: string[]): string | null {
  const flag = flags.find((f) => process.env[f] !== undefined);
  return flag && process.env[flag] === "0" ? flag : null;
}

// Its row on Add agents: off (`off`, the env var that says so), refused, or connected or not, and where it runs.
export function remoteRow({ off, error, connected, where }: { off: string | null; error: string | null; connected: boolean; where: string }): RuntimeRow {
  if (off) return { remote: true, ok: false, status: "Off", detail: `${off}=0 leaves it off.` };
  if (error) return { remote: true, ok: false, status: "Can't reach it", detail: error };
  return { remote: true, ok: connected, status: connected ? "Connected" : "Not connected", detail: connected ? where : `${where} Add its key below.` };
}
