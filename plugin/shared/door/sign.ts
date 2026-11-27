// Every record says who wrote it, signed with their door's key: when a group's
// home passes bob's thread on to carol, carol's page checks it's bob's, unchanged, and under the handle bob went by.
// A hub can hold something back; it can't put words in someone's mouth, or another name on them. The door signs each
// record it sends that has no author yet (its own person's); a record passed on keeps its author's signature.

import crypto from "node:crypto";

// The same JSON whatever order its keys were written in.
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

export interface Signable {
  type: string;
  id: string;
  v: string;
  body: unknown;
  space?: string;
  mentions?: string[];
}
// What a record's author signs, with the handle they go by: never what a door signs for the relay, nor anything else.
export function recordInput(r: Signable, handle: string): Buffer {
  const hash = crypto.createHash("sha256").update(canonical({ body: r.body, mentions: r.mentions ?? [] })).digest("base64url");
  return Buffer.from(`agentbook-record\n${handle}\n${r.type}\n${r.id}\n${r.v}\n${r.space ?? ""}\n${hash}`);
}
export function signRecord(r: Signable, handle: string, key: crypto.KeyObject): string {
  return crypto.sign(null, recordInput(r, handle), key).toString("base64url");
}
// Whether `sig` is the signature of the door with public key `x` (a JWK's x) on this record, by someone going by `handle`.
export function recordHolds(r: Signable, handle: string, sig: string, x: string): boolean {
  try {
    const key = crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" });
    return crypto.verify(null, recordInput(r, handle), key, Buffer.from(sig, "base64url"));
  } catch {
    return false;
  }
}
// A version for a record's body: the same body, the same version.
// A comment as a record: what its author's door signs, and what the thread's owner passes on with that signature.
export const commentRecord = (c: { id: string; thread: string; text: string; at: string }): Signable => ({ type: "comment", id: c.id, v: "1", body: { thread: c.thread, text: c.text, at: c.at } });
export const versionOf = (body: unknown): string => crypto.createHash("sha256").update(canonical(body)).digest("base64url").slice(0, 22);
