// agentbook's page (web/), as the server hands it out: index.html, its code (web/main.tsx and everything it imports,
// bundled by esbuild into app.js and app.css), its stylesheet, its fonts and the privacy note, by path.
//
// In the one-file build (build.ts), these are built once and carried inside the bundle (AGENTBOOK_WEB below). A server
// under Node's permission model (bin/agentbook-server) can't start esbuild, nor read web/: its launcher builds them
// into a folder it may read (`node build.ts --web DIR`), named by AGENTBOOK_WEB_DIR. Otherwise, run from the source,
// esbuild builds them on the first request, and again once a file under web/ changes, so a change shows on the next
// reload with nothing to run.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

export interface WebAsset {
  type: string;
  body: Buffer;
  // Its body gzipped, once a browser asked for it so (sent).
  gz?: Buffer;
}
export type WebAssets = Map<string, WebAsset>;

// Put here by build.ts: each asset's path, type and base64 body. Undefined when run from the source.
declare const AGENTBOOK_WEB: Record<string, { type: string; b64: string }> | undefined;

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".map": "application/json", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8" };
// The files served as they are, beside the code esbuild builds.
const STATIC = ["index.html", "privacy.html", "agentbook.css", "fonts/fonts.css", "fonts/Geist-Variable.woff2", "fonts/GeistMono-Variable.woff2", "fonts/LICENSE.txt"];

let built: { at: number; assets: WebAssets; stamp: string } | null = null;
let building: Promise<WebAssets> | null = null;

// The newest change under web/, to know when to build again.
function newest(dir = WEB): number {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    n = Math.max(n, e.isDirectory() ? newest(p) : fs.statSync(p).mtimeMs);
  }
  return n;
}

// Build the page from web/ into memory: app.js and app.css from web/main.tsx, and the files served as they are.
// Always as it's sent to a browser, minified and with React's production build (the development one is eight times
// the size, too much for a phone on every load). `map`: with its source map beside it (app.js.map), which only
// devtools asks for, for a server run from the source. `dir`: written into that folder too, for a server that can't
// build it (AGENTBOOK_WEB_DIR).
export async function buildWeb({ map = false, dir = "" }: { map?: boolean; dir?: string } = {}): Promise<WebAssets> {
  const esbuild = await import("esbuild");
  const out = await esbuild.build({
    entryPoints: { app: path.join(WEB, "main.tsx") },
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    write: false,
    outdir: "/",
    minify: true,
    sourcemap: map ? "linked" : false,
    loader: { ".woff2": "file" },
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    logLevel: "silent",
    // esbuild is a dev dependency: the one-file build carries what it built, and never asks for it.
  });
  const assets: WebAssets = new Map();
  for (const f of out.outputFiles) assets.set(path.basename(f.path), { type: TYPES[path.extname(f.path)] || "application/octet-stream", body: Buffer.from(f.contents) });
  for (const f of STATIC) assets.set(f, { type: TYPES[path.extname(f)] || "application/octet-stream", body: fs.readFileSync(path.join(WEB, f)) });
  // index.html links app.css: there's one even while no code imports a stylesheet.
  if (!assets.has("app.css")) assets.set("app.css", { type: TYPES[".css"], body: Buffer.alloc(0) });
  if (dir) {
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of assets) {
      fs.mkdirSync(path.dirname(path.join(dir, k)), { recursive: true });
      fs.writeFileSync(path.join(dir, k), v.body);
    }
  }
  return assets;
}

// The files in a folder build.ts --web wrote, by their paths there.
function readBuilt(dir: string, rel = "", out: WebAssets = new Map()): WebAssets {
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) readBuilt(dir, r, out);
    else out.set(r, { type: TYPES[path.extname(r)] || "application/octet-stream", body: fs.readFileSync(path.join(dir, r)) });
  }
  return out;
}

// The page's files, built or carried.
export async function webAssets(): Promise<WebAssets> {
  if (typeof AGENTBOOK_WEB !== "undefined") {
    if (!built) built = { at: 0, assets: new Map(Object.entries(AGENTBOOK_WEB).map(([k, v]) => [k, { type: v.type, body: Buffer.from(v.b64, "base64") }])), stamp: "" };
    return built.assets;
  }
  if (process.env.AGENTBOOK_WEB_DIR) {
    if (!built) built = { at: 0, assets: readBuilt(process.env.AGENTBOOK_WEB_DIR), stamp: "" };
    return built.assets;
  }
  const at = newest();
  if (built && built.at >= at) return built.assets;
  building ||= buildWeb({ map: true })
    .then((assets) => {
      built = { at, assets, stamp: "" };
      return assets;
    })
    .finally(() => (building = null));
  return building;
}

// What to send of `a` to a browser that says it takes `accepts` (its Accept-Encoding): its text gzipped when it takes
// that (every browser does), a fifth of the size; the rest (fonts, already compressed) as it is.
export function sent(a: WebAsset, accepts: string | undefined): { body: Buffer; gzip: boolean } {
  if (!/\bgzip\b/.test(accepts || "") || !/^(text\/|application\/json)/.test(a.type) || a.body.length < 1024) return { body: a.body, gzip: false };
  a.gz ||= zlib.gzipSync(a.body);
  return { body: a.gz, gzip: true };
}

// Which page code this server hands out (each page hears it, and one that loaded older code loads again).
export async function webStamp(): Promise<string> {
  const assets = await webAssets();
  if (built && !built.stamp) built.stamp = crypto.createHash("sha256").update(assets.get("app.js")?.body || "").digest("hex").slice(0, 12);
  return built?.stamp || "";
}
