// What every machine on an agentbook account does to link to the others, over iroh, whether it serves a page
// (server/mesh.ts) or not (plugin/cli/mesh.ts): the relay's list of the account's machines, kept fresh, which says
// who connects over iroh, and the hello each machine sends the others, signed with its key, with its certificate.

import crypto from "node:crypto";
import { machineKey, relayCall, saveMachineLogin } from "./machine-login.ts";
import type { MachineLogin, RelayMachine } from "./machine-login.ts";
import { createVerifier, publicKeyOf, SIGNED_SECONDS } from "./relay-verify.ts";
import type { MachineClaims } from "./relay-verify.ts";

export const LINK_PATH = "/api/cli/mesh/link";
export const SITE_PATH = "/api/cli/mesh/site";
export const UNLINK_PATH = "/api/cli/mesh/unlink";
// How long the relay's list of the account's machines is taken as it is, for one that links or connects here.
const LIST_MS = 5 * 60e3;

// `revoked`: the machine it's about is off the account, as the relay says now.
export type Failed = { error: string; status: number; revoked?: boolean };
// A hello's body: the sender's certificate, the machine it's for, where its page is as browsers open it (null: it has
// none) and its page's person (null with no page, or nobody on it yet).
export interface HelloBody {
  certificate: string;
  to: string;
  url: string | null;
  person: unknown;
}

// A page's address as given: http(s), no path, no trailing slash. Null for anything else.
export function pageAddress(u: unknown): string | null {
  try {
    const url = new URL(String(u ?? ""));
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

// What a machine signs as it links to another: never what it signs for the relay, so neither is taken as the other.
// `to`: the machine it's for, so it's taken by that one alone.
export function linkInput(at: number, to: string, body: string): Buffer {
  const hash = crypto.createHash("sha256").update(body).digest("base64url");
  return Buffer.from(`agentbook-mesh-link\n${to}\n${at}\n${hash}`);
}

// The hello to machine `to`, as `login`'s machine sends it: its body and Authorization header.
export function hello(login: MachineLogin, to: string, said: { url: string | null; person: unknown }): { body: string; authorization: string } {
  const body = JSON.stringify({ certificate: login.certificate, to, url: said.url, person: said.person } satisfies HelloBody);
  const at = Math.floor(Date.now() / 1000);
  const sig = crypto.sign(null, linkInput(at, to, body), machineKey(login)).toString("base64url");
  return { body, authorization: `Agentbook machine=${login.machine}, at=${at}, sig=${sig}` };
}

// The account's machines as the relay lists them, for the machine logged in with `login` (machine.json in `home`):
// renewed as it starts and daily, and asked again whenever a machine it doesn't know connects. `unlinked`: the relay
// says this machine was taken off the account (once).
export function createAccountList({ home, login: given, log, unlinked }: { home: string; login: MachineLogin; log: (line: string) => void; unlinked: (revoked?: string) => void }) {
  let login = given;
  const verifier = createVerifier({ relay: login.relay });
  let list: { at: number; machines: RelayMachine[] } = { at: 0, machines: Array.isArray(login.machines) ? login.machines : [] };
  // When the relay said this machine was taken off the account.
  let off: string | null = null;
  // When it last asked the relay about each key it didn't know, and about any (admit).
  const asked = new Map<string, number>();
  let askedAll: number[] = [];
  // Hellos taken, by their signatures and when they were made, so none is taken twice.
  const seen = new Map<string, number>();

  function keep(l: MachineLogin) {
    login = l;
    try {
      saveMachineLogin(home, l);
    } catch (e) {
      log(`mesh: couldn't keep this machine's login (${e.message}): it has it until it stops`);
    }
  }
  function heard(machines: unknown) {
    if (Array.isArray(machines)) list = { at: Date.now(), machines: machines as RelayMachine[] };
  }
  function wentOff(revoked?: string) {
    if (off) return;
    off = revoked || new Date().toISOString();
    unlinked(revoked);
  }
  // A fresh certificate, and the account's machines: whether the relay gave them.
  async function renew(): Promise<boolean> {
    if (off) return false;
    try {
      const r = await relayCall<{ certificate: string; expires_at: string; name: string; machines: RelayMachine[]; revoked?: string }>(login.relay, "POST", "/machines/renew", { login });
      if (r.status === 403 && r.body.error === "unlinked") return (wentOff(r.body.revoked), false);
      if (r.status !== 200 || typeof r.body.certificate !== "string") throw new Error(r.body.error || `HTTP ${r.status}`);
      keep({ ...login, certificate: r.body.certificate, expires_at: r.body.expires_at, name: r.body.name || login.name, machines: r.body.machines || [] });
      heard(r.body.machines);
      return true;
    } catch (e) {
      log(`mesh: couldn't renew this machine's certificate with the relay: ${e.message}`);
      return false;
    }
  }
  // The account's machines, as the relay says now; null when it couldn't be asked.
  async function machinesNow(): Promise<RelayMachine[] | null> {
    if (off) return null;
    try {
      const r = await relayCall<{ machines: RelayMachine[]; revoked?: string }>(login.relay, "GET", "/machines", { login });
      if (r.status === 403 && r.body.error === "unlinked") return (wentOff(r.body.revoked), null);
      if (r.status !== 200 || !Array.isArray(r.body.machines)) throw new Error(r.body.error || `HTTP ${r.status}`);
      heard(r.body.machines);
      return list.machines;
    } catch (e) {
      log(`mesh: couldn't ask the relay for your machines: ${e.message}`);
      return null;
    }
  }
  // Whether a machine connecting over iroh with `key` gets in: one of the account's, as the relay listed them, that
  // isn't this one or off the account. A key the list doesn't have (a machine logged in since) is asked about of the
  // relay, each at most once a minute, and ten a minute in all.
  async function admit(key: string): Promise<boolean> {
    if (off) return false;
    const listed = () => list.machines.find((m) => m.key === key);
    const ok = (m: RelayMachine | undefined) => !!m && m.id !== login.machine && !m.revoked;
    if (listed()) return ok(listed());
    const now = Date.now();
    askedAll = askedAll.filter((t) => now - t < 60e3);
    if (now - (asked.get(key) ?? 0) < 60e3 || askedAll.length >= 10) return false;
    if (asked.size > 1000) asked.clear();
    asked.set(key, now);
    askedAll.push(now);
    return !!(await machinesNow()) && ok(listed());
  }

  // Another machine's hello, with the request's Authorization header and body as sent, over iroh (`irohKey`: the
  // calling machine's key, as its connection proved it): its certificate checked against the relay's keys and this
  // machine's account, for that key, and the signature; and with the relay, that it's still on the account (a
  // certificate holds for a week; with the relay out of reach, the certificate's word is taken).
  async function checkHello(authorization: string | undefined, text: string, irohKey: string): Promise<{ cert: MachineClaims; body: Partial<HelloBody> } | Failed> {
    if (off) return { error: "This machine was taken off your agentbook.", status: 409 };
    const a = /^Agentbook\s+(.+)$/i.exec(String(authorization || ""));
    const said: Record<string, string> = {};
    for (const [, k, v] of a ? a[1].matchAll(/(\w+)=([^,\s]+)/g) : []) said[k] = v;
    const t = Number(said.at);
    if (!said.machine || !said.sig || !Number.isInteger(t)) return { error: "Sign it with the machine's key.", status: 401 };
    if (Math.abs(Date.now() / 1000 - t) > SIGNED_SECONDS) return { error: "That was signed too long ago: is either machine's clock right?", status: 401 };
    let body: Partial<HelloBody>;
    try {
      body = JSON.parse(text);
    } catch {
      return { error: "That isn't JSON.", status: 400 };
    }
    if (body?.to !== login.machine) return { error: "That's for another machine.", status: 403 };
    let cert: MachineClaims;
    try {
      cert = await verifier.verifyMachine(String(body.certificate ?? ""));
    } catch (e) {
      return { error: `Its certificate isn't good: ${e.message}`, status: 401 };
    }
    if (cert.acct !== login.account) return { error: "That machine is on another agentbook account.", status: 403 };
    const key = publicKeyOf(cert.key);
    if (cert.sub !== said.machine || cert.sub === login.machine || !key) return { error: "That certificate isn't that machine's.", status: 401 };
    if (irohKey !== cert.key) return { error: "That certificate isn't the machine calling's.", status: 401 };
    if (!crypto.verify(null, linkInput(t, login.machine, text), key, Buffer.from(said.sig, "base64url"))) return { error: "That isn't signed with its key.", status: 401 };
    for (const [s, at] of seen) if (Date.now() / 1000 - at > SIGNED_SECONDS) seen.delete(s);
    if (seen.has(said.sig)) return { error: "That was sent already.", status: 401 };
    seen.set(said.sig, t);
    let m: RelayMachine | null | undefined = Date.now() - list.at < LIST_MS ? list.machines.find((x) => x.id === cert.sub) : undefined;
    if (!m) {
      const now = await machinesNow();
      if (off) return { error: "This machine was taken off your agentbook.", status: 409 };
      m = now ? (now.find((x) => x.id === cert.sub) ?? null) : undefined;
    }
    if (m === null || m?.revoked) return { error: "That machine isn't on your agentbook any more.", status: 403, revoked: !!m?.revoked };
    return { cert, body };
  }
  // The answer to this machine's hello to `m`, dialed by `key`: the certificate of the machine that answered, which
  // has to be `m`'s on this account, for that key. Throws when it isn't.
  async function checkAnswer(certificate: unknown, m: RelayMachine, key: string): Promise<MachineClaims> {
    const cert = await verifier.verifyMachine(String(certificate ?? "")).catch(() => null);
    if (!cert || cert.acct !== login.account || cert.sub !== m.id || cert.key !== key) throw new Error(`The machine that answered over iroh isn't ${m.name}, as the relay has it.`);
    return cert;
  }

  return {
    login: () => login,
    keep,
    off: () => off,
    machines: () => list.machines,
    // Whether the list is recent enough to go by for one that connects (else it's asked again).
    fresh: () => Date.now() - list.at < LIST_MS,
    renew,
    machinesNow,
    admit,
    checkHello,
    checkAnswer,
  };
}
export type AccountList = ReturnType<typeof createAccountList>;
