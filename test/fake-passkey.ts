// A passkey for tests: a key made the way an authenticator makes one (ES256, Ed25519 or RS256), and a command
// signed the way a browser's navigator.credentials.get() signs it, with the command's hash as the challenge.

import crypto from "node:crypto";
import { canonical, digestOf, envelope, type SignedCommand } from "../plugin/shared/signed.ts";
import type { PasskeySignature } from "../plugin/shared/types.ts";

// Where a passkey signs: the page's origin, and the relying party it was made for.
export interface Site {
  origin?: string;
  rpId?: string;
}
// `verified: false` signs as a tap without a face, a finger or a PIN; `challenge` signs something else.
export interface SignOptions extends Site {
  verified?: boolean;
  challenge?: string;
}
// A passkey as makePasskey makes it.
export type Passkey = ReturnType<typeof makePasskey>;

const sha256 = (b: Buffer) => crypto.createHash("sha256").update(b).digest();
// By COSE algorithm: -7 ES256, -8 Ed25519, -257 RS256.
const GEN: Record<number, () => crypto.KeyPairKeyObjectResult> = {
  "-7": () => crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }),
  "-8": () => crypto.generateKeyPairSync("ed25519"),
  "-257": () => crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }),
};

// `record` is what a machine keeps of it (gate.json's `keys`); `sign(c, { origin, rpId })` is its signature on a
// command. `verified: false` signs as a tap without a face, a finger or a PIN; `challenge` signs something else.
export function makePasskey(alg = -7, name = "test passkey") {
  const { publicKey, privateKey } = GEN[alg]();
  const record = { id: crypto.randomBytes(16).toString("base64url"), alg, spki: publicKey.export({ type: "spki", format: "der" }).toString("base64url"), name, added: new Date().toISOString() };
  function sign(c: SignedCommand | null, { origin, rpId, verified = true, challenge }: SignOptions = {}): PasskeySignature {
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: challenge ?? sha256(Buffer.from(canonical(envelope(c)))).toString("base64url"), origin, crossOrigin: false }));
    const authenticatorData = Buffer.concat([sha256(Buffer.from(rpId)), Buffer.from([0x01 | (verified ? 0x04 : 0)]), Buffer.alloc(4)]);
    const data = Buffer.concat([authenticatorData, sha256(clientDataJSON)]);
    const signature = alg === -7 ? crypto.sign("sha256", data, { key: privateKey, dsaEncoding: "der" }) : alg === -8 ? crypto.sign(null, data, privateKey) : crypto.sign("sha256", data, privateKey);
    return { key: record.id, authenticatorData: authenticatorData.toString("base64url"), clientDataJSON: clientDataJSON.toString("base64url"), signature: signature.toString("base64url") };
  }
  return { record, sign, privateKey };
}

// A passkey's signature over anything it signs besides a command (a routine's OK, a change of keys).
export function signPayload(passkey: Passkey, payload: unknown, { origin, rpId, verified = true }: SignOptions = {}): PasskeySignature {
  return passkey.sign(null, { origin, rpId, verified, challenge: digestOf(payload) });
}

// A browser's key for a while, so one Face ID covers hours of commands: made as WebCrypto makes one
// (ECDSA P-256), signed once by `passkey`, and signing each command over its canonical JSON, r||s as WebCrypto
// writes it. `hours`: how long the passkey signed it for; `at`: from when.
export function makeSession(passkey: Passkey, { origin, rpId, hours = 12, at = Date.now(), verified = true }: Site & { hours?: number; at?: number; verified?: boolean } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const env = { v: 1, kind: "session", key: { alg: -7, spki: publicKey.export({ type: "spki", format: "der" }).toString("base64url") }, at: new Date(at).toISOString(), expires: new Date(at + hours * 3600e3).toISOString() };
  const sig = signPayload(passkey, env, { origin, rpId, verified });
  function sign(c: SignedCommand | null) {
    return { key: sig.key, session: { envelope: env, sig }, signature: crypto.sign("sha256", Buffer.from(canonical(envelope(c))), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url") };
  }
  return { envelope: env, sig, sign, privateKey };
}
