// Whether this code runs from the one file build.ts makes (plugin/agentbook.mjs), and the plugin's folder either way.
// From the source, import.meta.url is this file's (plugin/shared/bundle.ts); in the bundle it's the bundle's own.
import path from "node:path";
import { fileURLToPath } from "node:url";

// Put in by build.ts (esbuild's define): true in the bundle. Undefined from the source.
declare const AGENTBOOK_BUNDLE: boolean | undefined;
export const BUNDLED = typeof AGENTBOOK_BUNDLE !== "undefined" && AGENTBOOK_BUNDLE === true;
// The plugin's folder this code runs from: the one with cli/, hooks/, mcp/ and .claude-plugin/.
export const CODE_ROOT = BUNDLED ? path.dirname(fileURLToPath(import.meta.url)) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The bundle itself, to start another of its parts with (`node agentbook.mjs admin …`). Null from the source.
export const BUNDLE_FILE = BUNDLED ? fileURLToPath(import.meta.url) : null;
// The page's server, when this runs from the bundle (entry.ts puts it there).
export const bundledServer = (): (() => Promise<unknown>) | undefined => globalThis[Symbol.for("agentbook.server.bundled")];
