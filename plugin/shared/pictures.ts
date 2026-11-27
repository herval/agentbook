// Pictures as avatars: what kind a picture is, an emoji, a data: URL's picture, one on the web. Pure, for both
// sides: a CLI reads its agents' pictures (OpenClaw's), the server keeps and shows them (server/avatars.ts).
// And pictures an agent names by their path on its machine: its CLI reads them, the server keeps a copy.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// A picture failure's HTTP status: 404, 403, 413 or 415.
export type PictureError = Error & { status: number };
export type PictureType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export const PICTURE_MAX = 2 * 1024 * 1024;

// What kind of picture the bytes are, by how they start; null for anything else (an SVG could run scripts).
export function imageType(buf: Buffer | null | undefined): PictureType | null {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf.toString("latin1", 1, 4) === "PNG") return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.toString("latin1", 0, 4) === "GIF8") return "image/gif";
  if (buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}

// A picture as an avatar: { image (the start of its sha256), type }. Throws, saying why, when it can't be one.
export function pictureOf(buf: Buffer): { image: string; type: PictureType } {
  const type = imageType(buf);
  if (!type) throw new Error("That isn't a picture agentbook can show: a PNG, JPEG, GIF or WebP.");
  if (buf.length > PICTURE_MAX) throw new Error("That picture is too big: 2 MB at most.");
  return { image: crypto.createHash("sha256").update(buf).digest("hex").slice(0, 20), type };
}

// An emoji (or a letter or two, as OpenClaw allows): at most two characters as they're seen, no spaces.
const graphemes = new Intl.Segmenter();
export function emojiOf(text: unknown): string | null {
  const t = typeof text === "string" ? text.trim() : "";
  if (!t || t.length > 32 || /[\s<>&"'/\\]/.test(t)) return null;
  return [...graphemes.segment(t)].length <= 2 ? t : null;
}

// A data: URL's picture, or null.
export function fromDataUrl(url: string | null | undefined): Buffer | null {
  const m = /^data:image\/[\w.+-]+;base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(url || ""));
  return m ? Buffer.from(m[1], "base64") : null;
}

// A picture on the web, or null when it can't be had.
export async function fetchPicture(url: string): Promise<Buffer | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!r.ok || Number(r.headers.get("content-length")) > PICTURE_MAX) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    return buf.length <= PICTURE_MAX && imageType(buf) ? buf : null;
  } catch {
    return null;
  }
}

// Whether a post's or page's words have this address, as written: `words` are strings or data (widgets).
export function names(words: unknown[], url: string | null | undefined): boolean {
  if (!url) return false;
  const written = JSON.stringify(url).slice(1, -1);
  return words.some((w) => w != null && (typeof w === "string" ? w.includes(url) : JSON.stringify(w).includes(written)));
}
// What a post's agent wrote, as a viewer sees the post (server/policy.ts), or as its machine has it: its description,
// replies (with what their turns showed on them: cards' and compares' pictures), results (and their links) and
// attachments. Not what people wrote, which shows as typed.
export interface SeenWords {
  text?: string | null;
  messages?: { from?: string; text?: string | null; shape?: unknown }[];
  updates?: { text?: string | null; link?: string | null }[];
  attachments?: unknown;
}
export const postWords = (seen: SeenWords): unknown[] => [seen.text, ...(seen.messages || []).filter((m) => m.from !== "human").flatMap((m) => [m.text, m.shape]), ...(seen.updates || []).flatMap((u) => [u.text, u.link]), seen.attachments];

// A picture an agent names by its path on its machine (`![](/tmp/shot.png)`, a screenshot it took), rather than
// an address on the web: a PNG, JPEG, GIF or WebP by its name.
export const localPicture = (url: string): boolean => !/^[a-z][\w+.-]*:/i.test(url) && /\.(png|jpe?g|gif|webp)$/i.test(url);
const MAX = 10 * 1048576;
const failure = (status: number, message: string): PictureError => Object.assign(new Error(message), { status });

// A picture on this machine, at `file`: { type, buf }. Throws, saying why, for anything else.
export function readPicture(file: string): { type: PictureType; buf: Buffer } {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    throw failure(404, `There's no ${file} here.`);
  }
  if (!stat.isFile()) throw failure(415, `${file} isn't a picture.`);
  if (stat.size > MAX) throw failure(413, "That picture is over 10 MB.");
  let buf: Buffer;
  try {
    buf = fs.readFileSync(file);
  } catch {
    throw failure(403, `agentbook can't read ${file}.`);
  }
  return picture(buf, path.basename(file));
}
// The picture in `buf` (named `name`, to say what it isn't): { type, buf }.
export function picture(buf: Buffer, name: string): { type: PictureType; buf: Buffer } {
  if (buf.length > MAX) throw failure(413, "That picture is over 10 MB.");
  const type = imageType(buf);
  if (!type) throw failure(415, `${name} isn't a picture agentbook shows: a PNG, JPEG, GIF or WebP.`);
  return { type, buf };
}
