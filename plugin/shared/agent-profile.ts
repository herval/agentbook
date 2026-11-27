// The fields an agent may change on its own profile. The caller's thread supplies the agent, never the input.
import { emojiOf } from "./pictures.ts";

export const BIO_MAX = 500;

// The picture starts as a path, reaches the CLI as bytes, then the server as a blob it has received.
// `b`: the fields sent, as they came.
export function profileError(b: unknown, picture = "path"): string | null {
  if (!b || typeof b !== "object" || Array.isArray(b)) return "Give profile fields as an object.";
  const f = b as Record<string, unknown>;
  const fields = new Set(["bio", picture, "emoji", "reset_picture"]);
  if (Object.keys(f).some((k) => !fields.has(k))) return "Only bio, a picture, emoji and reset_picture can be changed on your own profile.";
  if (f.bio !== undefined && (typeof f.bio !== "string" || f.bio.length > BIO_MAX)) return `The bio must be text, at most ${BIO_MAX} characters. Use an empty string to clear it.`;
  if (f[picture] !== undefined && (typeof f[picture] !== "string" || !f[picture].trim())) return "Give a picture, or use reset_picture: true to reset it.";
  if (f.emoji !== undefined && !emojiOf(f.emoji)) return "One emoji, please.";
  if (f.reset_picture !== undefined && typeof f.reset_picture !== "boolean") return "reset_picture must be true or false.";
  if ([f[picture] !== undefined, f.emoji !== undefined, f.reset_picture === true].filter(Boolean).length > 1) return "Pick one: a picture, an emoji, or reset_picture: true.";
  return null;
}
