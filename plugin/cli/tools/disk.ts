// The files an agent's tools name are on the machine it works on: this one, or its own, read through its driver
// (`who.disk`: an OpenClaw agent's are on its gateway's, a Claude Agent's in its sandbox).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Call, Disk } from "./tool.ts";

// This machine's. `stat`: a file's size, or null when there's none there.
export const localDisk: Disk = {
  home: os.homedir(),
  stat: async (p) => {
    try {
      const st = fs.statSync(p);
      return st.isFile() ? { size: st.size } : null;
    } catch {
      return null;
    }
  },
  read: async (p) => fs.readFileSync(p),
};
// Where a path an agent gives is: from the folder it works in, or its home for ~.
export const pathOn = (disk: Disk, where: string, p: string) => path.resolve(where, String(p).replace(/^file:\/\//, "").replace(/^~(?=\/)/, disk.home));

// agentbook shows note images from the web or from its own files. A note can also point at local images;
// upload those and point at the uploads.
const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i;
export async function embedImages(md: string, call: Call, where: string, disk: Disk) {
  const isUrl = (src) => /^(https?:\/\/|\/api\/files\/)/i.test(src);
  const refs = [...md.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => m[1]).filter((src) => !isUrl(src));
  if (!refs.length) return { md, missing: [] };
  const urls = new Map();
  const missing = [];
  for (const src of new Set(refs)) {
    const p = pathOn(disk, where, src);
    const st = IMAGE.test(p) ? await disk.stat(p) : null;
    if (!st || st.size > 10 * 1024 * 1024) {
      missing.push(src);
      continue;
    }
    const r = await call("POST", "/files", { name: path.basename(p), content_base64: (await disk.read(p)).toString("base64"), embedded: true }, { timeout: 30000 });
    urls.set(src, r.url);
  }
  return { md: md.replace(/(!\[[^\]]*\]\()([^)\s]+)\)/g, (m, head, src) => (urls.has(src) ? `${head}${urls.get(src)})` : m)), missing };
}
