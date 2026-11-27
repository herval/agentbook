// Running a runtime's program, and saying which of two things went wrong when it can't start: the folder it was to
// run in (gone, or not this user's to open), or the program (not installed here). Node says ENOENT for both.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const whoAmI = () => {
  try {
    return os.userInfo().username;
  } catch {
    return `uid ${process.getuid?.()}`;
  }
};

// What's wrong with a folder a program is to run in, or null when it can be.
export function folderTrouble(cwd: string | null | undefined) {
  if (!cwd) return null;
  try {
    fs.accessSync(cwd, fs.constants.X_OK);
    return null;
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") return new Error(`Its folder is gone (${cwd}).`);
    return new Error(`agentbook-cli here runs as ${whoAmI()}, who can't open its folder (${cwd}).`);
  }
}
// A program that didn't start: its folder's trouble, or else `missing` ("Hermes isn't installed here.").
export const goneOrMissing = (cwd: string | null | undefined, missing: string) => folderTrouble(cwd) || new Error(missing);

// Where a command is on PATH (or the path it is, when it has a slash), if it's there and runs.
export function onPath(cmd: string) {
  const runs = (p: string) => {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (cmd.includes("/")) return runs(cmd) ? cmd : null;
  for (const dir of (process.env.PATH || "").split(path.delimiter)) if (dir && runs(path.join(dir, cmd))) return path.join(dir, cmd);
  return null;
}

// A folder a thread is to start in: there, and a folder, or why not.
export function startFolder(cwd: string | null | undefined) {
  if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(`No folder at ${cwd}`);
  return cwd;
}
