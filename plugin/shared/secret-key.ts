// The secret key agentbook-server seals what it keeps for people with (server/secrets.ts), when nothing gives it one
// (AGENTBOOK_SECRET_KEY in its environment, or in .env beside its checkout): one this machine makes for itself the
// first time and keeps from then on, outside agentbook's data folder, so a copy or a backup of that folder has only
// sealed values. It's in ~/.config/agentbook/secret-key (agentbook/ in XDG_CONFIG_HOME, when that's set), or
// AGENTBOOK_SECRET_KEY_FILE, readable only by you. Losing it loses only what it sealed: people sign in to GitHub and
// paste their API keys again.
//
// Not the macOS keychain: an item made by the `security` command is read back by any process that runs it, so it
// guards no better than a file only you can read, and a keychain that's locked (a login over ssh) would leave the
// server with no key, or a second one.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BUNDLED } from "./bundle.ts";

export const secretKeyFile = () => process.env.AGENTBOOK_SECRET_KEY_FILE || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "agentbook", "secret-key");

// -> the key, as AGENTBOOK_SECRET_KEY takes it: the one kept in `file`, else a new one, kept there now. Two starts at
// once keep one key: whichever writes the file second takes the first's.
export function ownSecretKey(file = secretKeyFile()): string {
  const read = () => {
    try {
      return fs.readFileSync(file, "utf8").trim();
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
  };
  const had = read();
  if (had) return had;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const key = crypto.randomBytes(32).toString("base64");
  try {
    // An empty file sealed nothing: it's written over.
    fs.writeFileSync(file, key + "\n", { flag: had === "" ? "w" : "wx", mode: 0o600 });
    return key;
  } catch (e) {
    if (e.code === "EEXIST" && read()) return read();
    throw e;
  }
}

// bin/agentbook-server runs this with its .env, before it starts the server under Node's permission model (where it
// may read only its code and data): it prints the key to use, or nothing when the environment or .env has one.
if (!BUNDLED && process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)) && process.env.AGENTBOOK_SECRET_KEY === undefined) process.stdout.write(ownSecretKey());
