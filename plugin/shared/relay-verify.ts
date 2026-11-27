import crypto from "node:crypto";

/**
 * What a page and a machine need to trust agentbook-relay (../agentbook-relay, its PROTOCOL.md), and to talk to it: a
 * copy of the relay's src/verify.ts, kept the same. The page's routes that use it are server/api/signin.ts; the
 * machine's, plugin/cli/relay-login.ts.
 *
 * A sign-in token holds (`verify`) when
 *   - its signature is from one of the relay's keys (/.well-known/jwks.json, fetched again for a key it doesn't know),
 *   - it was issued by that relay, for this page's own origin (`aud`), with the nonce this page sent,
 *   - it's fresh (`exp`, give or take a minute), and
 *   - it hasn't been used here before (`jti`, kept until it expires).
 *
 * A machine's certificate holds (`verifyMachine`) when it's signed by one of the relay's keys, as a certificate
 * (`typ`), by that relay, and not expired. It says which account the machine is, and its public key.
 *
 * A door's certificate holds (`verifyDoor`) the same way: it says which account's door a key is, and nothing else
 * about the account (no handle or name: people go by what they call themselves, in their own words).
 *
 * A machine signs what it sends the relay (`machineAuthorization`), with its own key.
 */
export const MACHINE_TYP = "agentbook-machine+jwt";
/** A door's certificate: "door key `key` is account `acct`'s". */
export const DOOR_TYP = "agentbook-door+jwt";
export interface RelayIdentity {
  /** `<provider>:<the provider's id>`, e.g. `google:1170…`: stable, unlike the email. */
  sub: string;
  provider: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
  hd?: string;
}
export interface RelayClaims extends RelayIdentity {
  /** The relay's account for this identity: what a page compares with its machine's certificate. */
  acct: string;
  iss: string;
  aud: string;
  nonce: string;
  iat: number;
  exp: number;
  jti: string;
}
export interface MachineClaims {
  iss: string;
  /** The machine's id. */
  sub: string;
  acct: string;
  /** Its Ed25519 public key, as a JWK's `x`. */
  key: string;
  name: string;
  iat: number;
  exp: number;
}
export interface DoorClaims {
  iss: string;
  /** The account's id, as `acct`. */
  sub: string;
  acct: string;
  /** The door's Ed25519 public key, as a JWK's `x`. */
  key: string;
  iat: number;
  exp: number;
}
export class RelayTokenError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.reason = reason;
  }
}

export interface VerifierOptions {
  /** The relay's address, e.g. https://relay.agentbook.dev: its tokens' `iss`. */
  relay: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** How far clocks may disagree, in seconds. */
  skew?: number;
}

const REFETCH_MS = 30_000;

export function createVerifier(options: VerifierOptions) {
  const relay = options.relay.replace(/\/+$/, "");
  const get = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const skew = options.skew ?? 60;
  let keys = new Map<string, crypto.KeyObject>();
  let fetchedAt = 0;
  let fetching: Promise<void> | null = null;
  const used = new Map<string, number>(); // jti → exp (s)

  async function loadKeys(): Promise<void> {
    fetching ??= (async () => {
      try {
        const r = await get(`${relay}/.well-known/jwks.json`, { signal: AbortSignal.timeout(10_000) });
        if (!r.ok) throw new RelayTokenError("keys", `The relay's keys didn't load (${r.status}).`);
        const body = (await r.json()) as { keys?: Array<Record<string, unknown>> };
        const next = new Map<string, crypto.KeyObject>();
        for (const k of body.keys ?? []) {
          if (k.kty !== "OKP" || k.crv !== "Ed25519" || typeof k.kid !== "string" || typeof k.x !== "string") continue;
          next.set(k.kid, crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: k.x }, format: "jwk" }));
        }
        keys = next;
        fetchedAt = now();
      } finally {
        fetching = null;
      }
    })();
    return fetching;
  }

  async function keyFor(kid: string): Promise<crypto.KeyObject | null> {
    if (!keys.has(kid) && now() - fetchedAt > REFETCH_MS) await loadKeys();
    return keys.get(kid) ?? null;
  }

  /** A token's claims once its signature holds, signed as `typ`. `anyTime`: one that has run out holds too. */
  async function signed<T extends { iss?: unknown; exp?: unknown; iat?: unknown }>(token: string, typ: string, what: string, anyTime = false): Promise<T> {
    const parts = String(token).split(".");
    if (parts.length !== 3) throw new RelayTokenError("malformed", `That isn't ${what}.`);
    let header: Record<string, unknown>;
    let claims: T;
    try {
      header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
      claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    } catch {
      throw new RelayTokenError("malformed", `That isn't ${what}.`);
    }
    if (header.alg !== "EdDSA" || typeof header.kid !== "string") throw new RelayTokenError("alg", "That token isn't signed the way the relay signs.");
    // A certificate never passes as a sign-in token, nor the other way.
    if (header.typ !== typ) throw new RelayTokenError("typ", `That isn't ${what}.`);
    const key = await keyFor(header.kid);
    if (!key) throw new RelayTokenError("kid", "That token was signed with a key the relay doesn't have.");
    if (!crypto.verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], "base64url"))) {
      throw new RelayTokenError("signature", "That token's signature doesn't hold.");
    }
    if (claims.iss !== relay) throw new RelayTokenError("iss", "That token is from another relay.");
    const seconds = Math.floor(now() / 1000);
    if (typeof claims.exp !== "number" || (!anyTime && claims.exp + skew < seconds)) throw new RelayTokenError("expired", "That has run out of time.");
    if (typeof claims.iat !== "number" || claims.iat - skew > seconds) throw new RelayTokenError("early", "That token is from the future: is this machine's clock right?");
    return claims;
  }

  /** The token's claims when it holds for this page (`audience`: the page's origin) and this nonce; throws when not. */
  async function verify(token: string, expect: { audience: string; nonce: string }): Promise<RelayClaims> {
    let claims: RelayClaims;
    try {
      claims = await signed<RelayClaims>(token, "JWT", "a sign-in token");
    } catch (e) {
      if (e instanceof RelayTokenError && e.reason === "expired") throw new RelayTokenError("expired", "That sign-in took too long. Sign in again.");
      throw e;
    }
    if (claims.aud !== expect.audience) throw new RelayTokenError("aud", "That token is for another page.");
    if (!expect.nonce || claims.nonce !== expect.nonce) throw new RelayTokenError("nonce", "That token is for another sign-in.");
    if (typeof claims.sub !== "string" || !claims.sub.includes(":") || typeof claims.acct !== "string" || typeof claims.jti !== "string") {
      throw new RelayTokenError("malformed", "That token doesn't say who signed in.");
    }
    const seconds = Math.floor(now() / 1000);
    for (const [jti, exp] of used) if (exp + skew < seconds) used.delete(jti);
    if (used.has(claims.jti)) throw new RelayTokenError("replayed", "That token was used already.");
    used.set(claims.jti, claims.exp);
    return claims;
  }

  /** A machine's certificate's claims, when the relay signed it and it hasn't run out; throws when not. Whether the
   * machine is still linked is the relay's to say (GET /machines): a certificate holds until it runs out. */
  async function verifyMachine(certificate: string): Promise<MachineClaims> {
    const claims = await signed<MachineClaims>(certificate, MACHINE_TYP, "a machine's certificate");
    if (typeof claims.sub !== "string" || typeof claims.acct !== "string" || typeof claims.key !== "string") {
      throw new RelayTokenError("malformed", "That certificate doesn't say which machine it is.");
    }
    return claims;
  }

  /**
   * A door's certificate's claims, when the relay signed it and it hasn't run out; throws when not. `anyTime`: one
   * that ran out holds too, for whose a record is that a group's home passes on (it was theirs when they signed it).
   */
  async function verifyDoor(certificate: string, { anyTime = false }: { anyTime?: boolean } = {}): Promise<DoorClaims> {
    const claims = await signed<DoorClaims>(certificate, DOOR_TYP, "a door's certificate", anyTime);
    if (typeof claims.acct !== "string" || claims.sub !== claims.acct || typeof claims.key !== "string") {
      throw new RelayTokenError("malformed", "That certificate doesn't say whose door it is.");
    }
    return claims;
  }

  return { verify, verifyMachine, verifyDoor, relay };
}

// A machine signing what it sends the relay. The header:
//   Authorization: Agentbook machine=<id>, at=<unix seconds>, sig=<base64url Ed25519 signature>
// over signingInput(method, path with its query, at, body). The relay takes it within 5 minutes of `at`.

export const SIGNED_SECONDS = 300;

export function signingInput(method: string, path: string, at: number, body: string | Uint8Array = ""): Buffer {
  const hash = crypto.createHash("sha256").update(body).digest("base64url");
  return Buffer.from(`agentbook-relay-request\n${method.toUpperCase()}\n${path}\n${at}\n${hash}`);
}

/** The Authorization header for a request a machine sends the relay. `path` includes its query. */
export function machineAuthorization(a: { machine: string; privateKey: crypto.KeyObject; method: string; path: string; body?: string; at?: number }): string {
  const at = a.at ?? Math.floor(Date.now() / 1000);
  const sig = crypto.sign(null, signingInput(a.method, a.path, at, a.body ?? ""), a.privateKey).toString("base64url");
  return `Agentbook machine=${a.machine}, at=${at}, sig=${sig}`;
}

/** What a door's key signs to show it's the account's (POST /doors): never what it signs for anything else. */
export function doorProofInput(account: string, key: string): Buffer {
  return Buffer.from(`agentbook-relay-door\n${account}\n${key}`);
}

/** What a machine signs to show it holds its key as it takes its certificate (POST /device/token). */
export function deviceProofInput(deviceCode: string): Buffer {
  return Buffer.from(`agentbook-relay-device\n${deviceCode}`);
}

/** An Ed25519 public key from a JWK's `x`, or null when it isn't one. */
export function publicKeyOf(x: string): crypto.KeyObject | null {
  if (typeof x !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(x)) return null;
  try {
    return crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" });
  } catch {
    return null;
  }
}
