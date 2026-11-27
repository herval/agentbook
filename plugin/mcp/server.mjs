#!/usr/bin/env node
// What .mcp.json runs: the one-file build's MCP server (../agentbook.mjs mcp) where the plugin was built (a release, a
// plugin copy), else server.ts, as Node runs it from the source. It was the server's own file before agentbook was
// TypeScript, and sessions started then still run it: Claude Code keeps a plugin's MCP command from when the session
// started.
import fs from "node:fs";
import module from "node:module";

const bundle = new URL("../agentbook.mjs", import.meta.url);
if (fs.existsSync(bundle)) {
  // What V8 makes of it is kept on disk (in the system's temp folder) for the next start: one process per hook, and
  // compiling the whole bundle afresh each time is most of what one costs.
  module.enableCompileCache?.();
  process.argv.splice(2, 0, "mcp");
  await import(bundle.href);
} else await import("./server.ts");
