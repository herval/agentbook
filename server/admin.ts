#!/usr/bin/env node
// agentbook-server's commands, run where it keeps its data (bin/agentbook-server passes them here):
//   link                        a one-time code that links another machine of yours to this one (mesh.ts): run
//                               what it prints on that machine within 10 minutes
//   import <folder> [--server URL] [--name N] [--owner U]
//                               take in an agentbook data folder from before the split (import.ts), with the
//                               server stopped
//   backup <folder>             a copy of the server's data folder, while it runs (backup.ts)
//   secret-key                  a new key for AGENTBOOK_SECRET_KEY, which encrypts the API keys it keeps (secrets.ts)
//   cli-latest [<version>|none] the newest agentbook-cli its machines are told of, said to the running server with
//                               no restart: machines that update themselves go to it. Alone, what it says now.
// Nobody makes an account here: a page is its machine's account's (agentbook login), whose person signs in with
// Google.

import fs from "node:fs";
import path from "node:path";
import { cliLatest, PUBLIC_URL, SERVER_HOME, STORAGE_ROOT, setCliLatest } from "./config.ts";
import { backupData } from "./backup.ts";
import { importData } from "./import.ts";
import { ENV as KEY_ENV, newKey } from "./secrets.ts";
import { Storage } from "../plugin/shared/storage.ts";
import { PAGE_TABLES } from "./storage/page.ts";
import { createAccounts } from "./accounts.ts";

// New files 0600, new dirs 0700: the data folder, a backup and an imported folder are this user's alone.
process.umask(0o077);
const [cmd, ...args] = process.argv.slice(2);
const die = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};
// Its storage (with its database from before storage.db folded in, as the server does when it starts).
const storage = () => {
  fs.mkdirSync(SERVER_HOME, { recursive: true });
  const s = Storage.open(STORAGE_ROOT);
  s.adopt(path.join(SERVER_HOME, "agentbook.db"), { scope: "server", globals: PAGE_TABLES });
  return s;
};
switch (cmd) {
  case "backup": {
    const to = args.find((a) => !a.startsWith("--"));
    if (!to) die("usage: agentbook-server backup <folder>");
    const dest = path.resolve(to.replace(/^~(?=\/|$)/, process.env.HOME));
    try {
      const n = backupData({ from: SERVER_HOME, to: dest, storage: path.join(STORAGE_ROOT, "storage.db") });
      console.log(`Backed up ${n.databases} databases and ${n.files} files to ${dest}. To restore, start agentbook-server with AGENTBOOK_SERVER_HOME=${dest}${STORAGE_ROOT === SERVER_HOME ? ` (or put it in place of ${SERVER_HOME}, stopped)` : ""}, and the ${KEY_ENV} it has now: the connectors' API keys in it are encrypted with it, and it isn't in the copy.`);
    } catch (e) {
      die(e.message);
    }
    break;
  }
  case "import": {
    const from = args.find((a, i) => !a.startsWith("--") && !String(args[i - 1]).startsWith("--"));
    if (!from) die("usage: agentbook-server import <folder> [--server <its address for the machine>] [--name <machine>] [--owner <username>]");
    const opt = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
    const server = opt("--server") || PUBLIC_URL;
    // Its database is the server's own: not while it runs.
    const running = await fetch(`${PUBLIC_URL}/api/health`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok).catch(() => false);
    if (running) die(`agentbook-server is running at ${PUBLIC_URL}: stop it first, then import, then start it again.`);
    try {
      const said = importData({ from: path.resolve(from.replace(/^~(?=\/|$)/, process.env.HOME)), serverHome: SERVER_HOME, storage: storage(), server, name: opt("--name"), owner: opt("--owner") });
      console.log(`Imported ${said.join(", ") || "nothing new"}.\nStart agentbook-server, then this machine's agentbook-cli: its threads go up the first time it connects.`);
    } catch (e) {
      die(e.message);
    }
    break;
  }
  case "secret-key":
    // Only printed: where it's kept is yours to pick (a Fly secret, your shell's profile), never the data folder.
    console.log(newKey());
    if (process.stdout.isTTY) console.error(`\nSet it as ${KEY_ENV} where agentbook-server runs, and keep a copy somewhere safe: without it, the API keys it keeps can't be read.`);
    break;
  case "cli-latest": {
    const [v] = args;
    if (v) {
      try {
        setCliLatest(v === "none" ? null : v);
      } catch (e) {
        die(`${e.message}: agentbook-server cli-latest <version> | none`);
      }
    }
    const now = cliLatest();
    console.log(now ? `Machines are told agentbook-cli ${now} is the newest: those that update themselves go to it.` : "Machines are told nothing about a newer agentbook-cli.");
    break;
  }
  default:
    die("usage: agentbook-server link | import <folder> | backup <folder> | secret-key | cli-latest [<version>|none]");
}
process.exit(0);
