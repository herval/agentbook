// The secrets agentbook-server keeps for people (their connectors' API keys and GitHub sign-ins), sealed in its
// database with a key that's never in its data folder: AGENTBOOK_SECRET_KEY, 32 random bytes as base64 or hex
// (`agentbook-server secret-key` makes one), from its environment (.env, your shell), or else the one the machine
// made for itself, which whatever starts the server puts there (plugin/shared/secret-key.ts).
// A copy of the data folder, or a backup of it, has only the sealed values.
//
// Each value is sealed on its own: AES-256-GCM with a fresh IV, bound to what it is (`what`: its row and field, so
// one can't be moved into another's place), and saying which key sealed it, so a server with no key, or another
// one, says that rather than failing in some other way:
//
//   sealed:v1:<key id>:<iv>:<ciphertext>:<tag>      (base64url)

import crypto from "node:crypto";

const PREFIX = "sealed:v1:";
export const ENV = "AGENTBOOK_SECRET_KEY";

// A new key, as AGENTBOOK_SECRET_KEY takes it.
export const newKey = () => crypto.randomBytes(32).toString("base64");

// -> { key } or { error }: 64 hex digits, or base64 (or base64url) of 32 bytes.
function parse(text: unknown): { key?: Buffer | null; error?: string } {
  const s = String(text || "").trim();
  if (!s) return { key: null };
  let key: Buffer | null = null;
  if (/^[0-9a-f]{64}$/i.test(s)) key = Buffer.from(s, "hex");
  else if (/^[A-Za-z0-9+/_-]{43}=?$/.test(s)) key = Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (key?.length !== 32) return { error: `${ENV} isn't a key: it's 32 random bytes, as base64 or hex (\`agentbook-server secret-key\` makes one).` };
  return { key };
}

// What says which key sealed a value, without saying anything about the key.
const idOf = (key: Buffer) => crypto.createHash("sha256").update("agentbook-server secret key\0").update(key).digest("base64url").slice(0, 10);

export const isSealed = (v: unknown): v is string => typeof v === "string" && v.startsWith(PREFIX);

// `text`: the key as AGENTBOOK_SECRET_KEY has it.
export type Secrets = ReturnType<typeof createSecrets>;
export function createSecrets(text: string | undefined = process.env[ENV]) {
  const { key, error } = parse(text);
  const id = key ? idOf(key) : null;
  // Why nothing can be sealed or opened, or null.
  const problem = error || (key ? null : `agentbook-server has no secret key (${ENV}), so it keeps no API keys.`);
  return {
    ready: !!key,
    problem,
    // -> the sealed value. Throws without a key.
    seal(value: unknown, what: string): string {
      if (!key) throw Object.assign(new Error(problem), { status: 503 });
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv("aes-256-gcm", key, iv);
      c.setAAD(Buffer.from(String(what)));
      const ct = Buffer.concat([c.update(String(value), "utf8"), c.final()]);
      return PREFIX + [id, iv, ct, c.getAuthTag()].map((x) => (Buffer.isBuffer(x) ? x.toString("base64url") : x)).join(":");
    },
    // -> { value } or { error, why }: why is "none" (no key here), "other" (another key sealed it) or "broken".
    open(sealed: unknown, what: string): { value?: string; error?: string; why?: "none" | "other" | "broken" } {
      if (!isSealed(sealed)) return { error: "It isn't a sealed value.", why: "broken" };
      const [kid, iv, ct, tag] = sealed.slice(PREFIX.length).split(":");
      if (!key) return { error: problem, why: "none" };
      if (kid !== id) return { error: `It was sealed with another secret key than the ${ENV} agentbook-server has now.`, why: "other" };
      try {
        const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
        d.setAAD(Buffer.from(String(what)));
        d.setAuthTag(Buffer.from(tag, "base64url"));
        return { value: Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8") };
      } catch {
        return { error: "It can't be read: it was changed, or isn't where it was sealed for.", why: "broken" };
      }
    },
  };
}
