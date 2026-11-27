// agentbook's data folder, for whatever runs: AGENTBOOK_HOME when it's set (what agentbook-cli starts has it, and a
// test's), else the default account's (which accounts/accounts.json names), else the root itself (~/.agentbook, or
// AGENTBOOK_ROOT), as before accounts. An account's folder is accounts/<id>/ in the root, but for the one a machine's
// data from before accounts became, which stayed where it was: the root itself, with the account's machine.json at its
// top (plugin/cli/relay-login.ts). A hook or the tools of a session started outside agentbook (claude in a terminal)
// have no AGENTBOOK_HOME, and find the folder this way. plugin/cli/main.mjs picks it the same way before anything else
// loads. Nothing here but the file system, so a hook pays for no more than that.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const ROOT = process.env.AGENTBOOK_ROOT || path.join(os.homedir(), ".agentbook");
export const MACHINE_FILE = "machine.json";

// The account whose login is in this folder, or null.
export function accountIn(dir: string): string | null {
  try {
    const a = JSON.parse(fs.readFileSync(path.join(dir, MACHINE_FILE), "utf8"))?.account;
    return typeof a === "string" ? a : null;
  } catch {
    return null;
  }
}
export const accountHome = (account: string, root = ROOT) => (accountIn(root) === account ? root : path.join(root, "accounts", account));

// The default account (accounts.json), when its folder has its login.
export function defaultAccount(root = ROOT): string | null {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(root, "accounts", "accounts.json"), "utf8"))?.default;
    return typeof d === "string" && /^[\w-]+$/.test(d) && accountIn(accountHome(d, root)) === d ? d : null;
  } catch {
    return null;
  }
}

export function defaultHome(root = ROOT): string {
  const d = defaultAccount(root);
  return d ? accountHome(d, root) : root;
}

export const HOME = process.env.AGENTBOOK_HOME || defaultHome();
