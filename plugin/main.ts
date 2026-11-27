// agentbook in one file: build.ts bundles this into plugin/agentbook.mjs, and the first word says which part runs.
//   agentbook.mjs [COMMAND …]       agentbook-cli (cli/main.ts): the daemon, the page's server in it, and its commands
//   agentbook.mjs hook EVENT        a Claude Code hook (hooks/hook.ts)
//   agentbook.mjs mcp               the ab_* tools, for a Claude Code session (mcp/server.ts)
// Each part reads its own arguments from process.argv as when its file runs by itself, so the word naming it is taken
// out first. Run from the source, each part's own file is what runs (cli/main.mjs, hooks/hook.ts, mcp/server.ts).
// The launchers beside each part (cli/main.mjs, hooks/hook.mjs, mcp/server.mjs) start this, with V8's compile cache on.
const PARTS: Record<string, () => Promise<unknown>> = {
  hook: () => import("./hooks/hook.ts"),
  mcp: () => import("./mcp/server.ts"),
};
const part = PARTS[process.argv[2]];
if (part) {
  process.argv.splice(2, 1);
  await part();
} else (await import("./cli/main.ts")).main();
