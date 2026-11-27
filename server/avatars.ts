// Avatars. An agent shows the avatar you set on its profile, or else the one its runtime gives it (an
// OpenClaw agent's identity), or else its letter; a person shows the one they set on theirs, or else their
// letter. Either one is an emoji ({ emoji }) or a picture ({ image, type }); pictures are kept in
// the server's avatars/ folder (a Files of its storage, plugin/shared/storage.ts), named by what's in them, and served at /api/agents/<id>/avatar and
// /api/people/<username>/avatar. One a machine sent (an OpenClaw agent's) is a blob ({ image, type, blob }).

import path from "node:path";
import { SERVER_HOME } from "./config.ts";
import { emojiOf, imageType, pictureOf } from "../plugin/shared/pictures.ts";
import { Files } from "../plugin/shared/storage.ts";
import type { Avatar } from "../plugin/shared/types.ts";

export const AVATARS_DIR = path.join(SERVER_HOME, "avatars");
// Where they're kept: the server's storage's folder for them, once it says (keepAvatarsIn).
let avatars = new Files(AVATARS_DIR);
export const keepAvatarsIn = (files: Files) => (avatars = files);
const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

// The server fetches no picture by its address but through web-pictures.ts, which keeps to the public internet.
export { emojiOf, imageType, pictureOf };

// Keep a picture, and return it as an avatar. Throws, saying why, when it can't be one.
export function savePicture(buf: Buffer): { image: string; type: string } {
  const { image, type } = pictureOf(buf);
  const name = `${image}.${EXT[type]}`;
  if (!avatars.exists(name)) avatars.write(name, buf);
  return { image, type };
}
export const pictureFile = (pic: Avatar | null | undefined): string | null => (pic && EXT[pic.type] && /^[0-9a-f]{20}$/.test(pic.image || "") ? avatars.path(`${pic.image}.${EXT[pic.type]}`) : null);

// The pictures people show, which pruning keeps too (the server says how to list them).
let peoplePictures: () => (Avatar | null)[] = () => [];
export const keepPeoplePictures = (list: () => (Avatar | null)[]) => (peoplePictures = list);

// Remove the pictures no agent or person shows any more.
export function prunePictures(agents: Record<string, { avatar?: Avatar | null; avatar_default?: Avatar | null }>): void {
  const used = new Set<string>();
  for (const pic of [...Object.values(agents).flatMap((a) => [a.avatar, a.avatar_default]), ...peoplePictures()]) if (pictureFile(pic)) used.add(path.basename(pictureFile(pic)));
  for (const n of avatars.list()) if (!used.has(n)) avatars.remove(n);
}
