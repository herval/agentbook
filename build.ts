#!/usr/bin/env node
// agentbook as one file: esbuild bundles agentbook-cli, its hooks, its MCP server, the page's server and the page
// itself into plugin/agentbook.mjs, which runs on Node with nothing installed (plugin/main.ts says which part runs).
// The page (web/) is built first and carried inside it (server/web-assets.ts).
//
//   node build.ts [--out FILE] [--minify]
//
// By itself it makes dist/plugin/: the plugin folder with agentbook.mjs in it, which runs anywhere Node does
// (`node dist/plugin/agentbook.mjs webui`). Never into this checkout's plugin/: the launchers there (cli/main.mjs,
// hooks/hook.mjs, mcp/server.mjs) run agentbook.mjs when it's beside them, and would run it instead of the code you edit.
// --out FILE builds just the file (a plugin copy). --web DIR builds only the page, into DIR, for a server that can't
// build it itself (bin/agentbook-server, under Node's permission model: AGENTBOOK_WEB_DIR).
// From the source, nothing needs this: Node runs the .ts files as they are, and the server builds the page itself.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildWeb } from "./server/web-assets.ts";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(ROOT, "dist", "plugin");

// Build it into `out`. -> its size in bytes.
export async function buildBundle({ out = path.join(ROOT, "plugin", "agentbook.mjs"), minify = false }: { out?: string; minify?: boolean } = {}): Promise<number> {
  const esbuild = await import("esbuild");
  const web = await buildWeb();
  const define: Record<string, string> = {
    AGENTBOOK_BUNDLE: "true",
    AGENTBOOK_WEB: JSON.stringify(Object.fromEntries([...web].map(([k, v]) => [k, { type: v.type, b64: v.body.toString("base64") }]))),
  };
  const r = await esbuild.build({
    // The paths in its comments ("// plugin/cli/main.ts") are from the repo's top, wherever it's built.
    absWorkingDir: ROOT,
    entryPoints: [path.join(ROOT, "entry.ts")],
    outfile: out,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    minify,
    define,
    banner: { js: "#!/usr/bin/env node\n// agentbook, built by build.ts: the source is at https://github.com/herval/agentbook." },
    legalComments: "none",
    // iroh is native, and loaded only where it's installed (plugin/shared/iroh.ts): a bundle without it links machines
    // over HTTP.
    external: ["@number0/iroh"],
    metafile: true,
    logLevel: "warning",
  });
  return Object.values(r.metafile.outputs)[0].bytes;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const web = args.indexOf("--web");
  if (web >= 0) {
    await buildWeb({ dir: path.resolve(args[web + 1]) });
    process.exit(0);
  }
  const at = args.indexOf("--out");
  let out = at >= 0 ? path.resolve(args[at + 1]) : null;
  if (!out) {
    fs.rmSync(DIST, { recursive: true, force: true });
    fs.cpSync(path.join(ROOT, "plugin"), DIST, { recursive: true, filter: (p) => path.basename(p) !== "agentbook.mjs" });
    out = path.join(DIST, "agentbook.mjs");
  }
  const t = Date.now();
  const bytes = await buildBundle({ out, minify: args.includes("--minify") });
  console.log(`${path.relative(process.cwd(), out)}: ${(bytes / 1048576).toFixed(1)} MB in ${Date.now() - t} ms`);
}
