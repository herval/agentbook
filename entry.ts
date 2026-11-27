// The one-file build's entry (build.ts): agentbook-cli (plugin/main.ts) with the page's server and the page in it, so
// `node agentbook.mjs webui` needs nothing else, and `node agentbook.mjs admin …` is the server's accounts
// (server/admin.ts, which agentbook webui runs).
if (process.argv[2] === "admin") {
  process.argv.splice(2, 1);
  await import("./server/admin.ts");
} else {
  globalThis[Symbol.for("agentbook.server.bundled")] = () => import("./server/main.ts");
  await import("./plugin/main.ts");
}
