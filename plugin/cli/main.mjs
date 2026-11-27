#!/usr/bin/env node
// Where agentbook-cli starts: bin/agentbook-cli, the hooks, an update, a seat's systemd unit. The one file of agentbook's
// in plain JavaScript, for two reasons. A Node too old to run TypeScript can still read it, and says so here, with no
// stack and before anything touches the data folder. And the agentbook-cli versions already installed start this
// path when they update to a newer one (plugin/cli/update.ts), as do the systemd units seats were set up with, so it
// stays where it is. agentbook-cli itself is main.ts, or, where the plugin was built (a release, a plugin copy), the
// one file build.ts made of everything beside this folder: ../agentbook.mjs.

import fs from "node:fs";
import module from "node:module";
import os from "node:os";
import path from "node:path";

// The floor: plugin/lib/common.ts's NODE_MIN. Node runs .ts files without a flag from 22.18 (23.6 on the 23 line).
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 18) || (major === 23 && minor < 6)) {
  console.error(`agentbook-cli can't run here: it needs Node 22.18 or newer, and this is v${process.versions.node}. Update Node (https://nodejs.org), then try again.`);
  process.exit(1);
}
// Which account's folder it runs in, of the accounts this machine is signed in to: AGENTBOOK_HOME when that's set (a
// test's, or the account it was started for), else the default account's, in ~/.agentbook/accounts (AGENTBOOK_ROOT
// for another). With none, that folder itself, as before accounts. plugin/shared/home.ts picks it the same way, for
// what starts without this (a hook, a session's tools).
if (!process.env.AGENTBOOK_HOME) {
  const root = process.env.AGENTBOOK_ROOT || path.join(os.homedir(), ".agentbook");
  let home = process.env.AGENTBOOK_ROOT ? root : null;
  try {
    const d = JSON.parse(fs.readFileSync(path.join(root, "accounts", "accounts.json"), "utf8")).default;
    // The root itself, for the account its data from before accounts became (its machine.json is at the top).
    const here = (() => {
      try {
        return JSON.parse(fs.readFileSync(path.join(root, "machine.json"), "utf8")).account;
      } catch {
        return null;
      }
    })();
    if (typeof d === "string" && d === here) home = root;
    else if (typeof d === "string" && /^[\w-]+$/.test(d) && fs.existsSync(path.join(root, "accounts", d, "machine.json"))) home = path.join(root, "accounts", d);
  } catch {}
  if (home) process.env.AGENTBOOK_HOME = home;
}
const bundle = new URL("../agentbook.mjs", import.meta.url);
if (fs.existsSync(bundle)) {
  // What V8 makes of it is kept on disk (in the system's temp folder) for the next start.
  module.enableCompileCache?.();
  await import(bundle.href);
}
else (await import("./main.ts")).main();
