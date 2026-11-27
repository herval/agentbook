// A folder of files a store or the page keeps (what a thread was sent or made, blobs by their hash, avatars), handed
// out by Storage.files(dir). Names are relative to it, and can't leave it. Made 0700 when it's first used; files
// written 0600.

import fs from "node:fs";
import path from "node:path";

export class Files {
  dir: string;
  // Whether the folder was made, by this.
  made: boolean;
  constructor(dir: string) {
    this.dir = dir;
    this.made = false;
  }
  #ready() {
    if (!this.made) fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.made = true;
  }
  // Where a file of it is on disk (to hand to an agent, or stream). Throws for a name outside it.
  path(name: string): string {
    const p = path.resolve(this.dir, String(name));
    const rel = path.relative(this.dir, p);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`${name} isn't a file in ${this.dir}`);
    return p;
  }
  exists(name: string): boolean {
    return fs.existsSync(this.path(name));
  }
  // -> fs.Stats, or null when it isn't there.
  stat(name: string): fs.Stats | null {
    try {
      return fs.statSync(this.path(name));
    } catch {
      return null;
    }
  }
  // -> a Buffer (or a string, with `encoding`), or null when it isn't there.
  read(name: string): Buffer | null;
  read(name: string, encoding: BufferEncoding): string | null;
  read(name: string, encoding: BufferEncoding | null = null): Buffer | string | null {
    try {
      return fs.readFileSync(this.path(name), encoding);
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
  }
  // Written whole or not at all: to a file beside it, then renamed over it. -> its path
  write(name: string, data: string | NodeJS.ArrayBufferView, { mode = 0o600 }: { mode?: number } = {}): string {
    this.#ready();
    const p = this.path(name);
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmp, data, { mode });
      fs.renameSync(tmp, p);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e;
    }
    return p;
  }
  // A file from elsewhere, copied in. -> its path
  copyIn(from: string, name: string, { mode = 0o600 }: { mode?: number } = {}): string {
    this.#ready();
    const p = this.path(name);
    fs.copyFileSync(from, p);
    fs.chmodSync(p, mode);
    return p;
  }
  // -> whether it was there.
  remove(name: string): boolean {
    const p = this.path(name);
    const was = fs.existsSync(p);
    fs.rmSync(p, { force: true });
    return was;
  }
  list(): string[] {
    try {
      return fs.readdirSync(this.dir);
    } catch {
      return [];
    }
  }
  // The folder and all it has, gone.
  removeAll(): void {
    fs.rmSync(this.dir, { recursive: true, force: true });
    this.made = false;
  }
  // The folder and all it has, somewhere else (a machine that logged in again under a new id). -> the Files there
  moveTo(dir: string): Files {
    if (fs.existsSync(this.dir)) fs.renameSync(this.dir, dir);
    this.made = false;
    return new Files(dir);
  }
}
