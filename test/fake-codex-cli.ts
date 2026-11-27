#!/usr/bin/env node
// A stand-in for the `codex` command in tests: Codex Cloud's list, diff and apply, and starting the daemon.
// It records each call in FAKE_CODEX_CLI_LOG.

import fs from "node:fs";

const args = process.argv.slice(2);
if (process.env.FAKE_CODEX_CLI_LOG) fs.appendFileSync(process.env.FAKE_CODEX_CLI_LOG, JSON.stringify({ args, cwd: process.cwd() }) + "\n");
const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString();

if (args[0] === "cloud" && args[1] === "list") {
  const task = (id: string, title: string, status: string, updated: string, label: string, summary: object) => ({ id, url: `https://chatgpt.com/codex/tasks/${id}`, title, status, updated_at: updated, environment_id: null, environment_label: label, summary, is_review: false, attempt_total: 1 });
  console.log(JSON.stringify({ tasks: [task("task_e_1", "Add a health check", "ready", ago(600), "me/dashy", { files_changed: 1, lines_added: 3, lines_removed: 0 }), task("task_e_2", "Bump the parser", "pending", ago(60), "me/dashy", {}), task("task_e_old", "Something from last month", "ready", ago(60 * 86400), "me/dashy", {})] }, null, 2));
} else if (args[0] === "cloud" && args[1] === "status") {
  if (!/^task_/.test(args[2] || "")) {
    console.error("error: task not found");
    process.exit(1);
  }
  console.log("[READY] Tune the retry backoff\nme/dashy  •  Mar 3 10:12\n+12/-4 • 3 files");
} else if (args[0] === "cloud" && args[1] === "diff") {
  console.log("diff --git a/health.js b/health.js\nnew file mode 100644\n--- /dev/null\n+++ b/health.js\n@@ -0,0 +1 @@\n+export const ok = () => true; // hello");
} else if (args[0] === "cloud" && args[1] === "apply") {
  console.log(`Applied ${args[2]} to the working tree.`);
} else if (args[0] === "app-server") {
  process.exit(0);
} else {
  console.error(`fake codex: unsupported ${args.join(" ")}`);
  process.exit(2);
}
