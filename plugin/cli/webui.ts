// agentbook's page in the process that serves this machine's sessions: `agentbook webui`. The first step from a
// server and its machines toward one program per machine. The server half (server/main.ts) is loaded into this
// daemon and listens on its own port, with its own data folder, as it did as agentbook-server; this daemon is logged
// in to it as before, over loopback. The two share one storage (plugin/shared/storage.ts), as they would as two
// processes.
//
// It serves the page when it's started to (`run --webui`, what `agentbook webui` starts), or when this machine is
// logged in to its own page (`local` in cli/device.json, on loopback) and nothing else answers there. An
// agentbook-server of its own from before this (bin/agentbook-server, under Node's permission model) is left be and
// used; once it stops, this serves the page in its place. Code without the server next to it (a plugin copy Claude
// Code installed, which a terminal session's hook starts this from) loads it from where `agentbook webui` last ran.

import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { pathToFileURL } from "node:url";
import { HOME } from "../shared/store.ts";
import { bundledServer, CODE_ROOT } from "../shared/bundle.ts";
import { ownSecretKey } from "../shared/secret-key.ts";
import { spawnDoor } from "../door/spawn.ts";
import { setDoorSpawner } from "../shared/door/process.ts";


// The page this loads starts your door through this process (plugin/shared/door/process.ts): it runs nothing itself.
setDoorSpawner(spawnDoor);

const REPO = path.resolve(CODE_ROOT, "..");
const SETTINGS = () => path.join(HOME, "cli", "settings.json");
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const RECHECK_MS = 30e3;
// How long a daemon that wasn't started to serve the page waits before it looks: an agentbook-server of its own
// started with it (agentbook up starts both at once) takes the port meanwhile, and is used.
const GRACE_MS = Number(process.env.AGENTBOOK_PAGE_GRACE_MS || 3000);
// What only the server may know: read as it loads, then gone from this process's environment, which every agent it
// starts gets a copy of.
const SERVER_ONLY = ["AGENTBOOK_SECRET_KEY"];

// The page's address here when this machine isn't logged in to it yet: AGENTBOOK_SERVER_PORT (4310), on loopback.
export const pageUrl = () => `http://127.0.0.1:${Number(process.env.AGENTBOOK_SERVER_PORT || 4310)}`;
// The checkout of agentbook whose server this serves the page with: this code's own, else the one `agentbook webui`
// last ran from (cli/settings.json, `page_from`). Null when there's neither. -> its folder
export function serverRepo() {
  if (fs.existsSync(path.join(REPO, "server", "main.ts"))) return REPO;
  try {
    const dir = JSON.parse(fs.readFileSync(SETTINGS(), "utf8")).page_from;
    if (typeof dir === "string" && path.isAbsolute(dir) && fs.existsSync(path.join(dir, "server", "main.ts"))) return dir;
  } catch {}
  return null;
}
export const canHost = () => !!serverRepo() || !!bundledServer();
// What `agentbook webui` keeps for a daemon started from elsewhere: this checkout, to serve the page from.
export function keepPageFrom() {
  if (!fs.existsSync(path.join(REPO, "server", "main.ts"))) return;
  let was: Record<string, unknown> = {};
  try {
    was = JSON.parse(fs.readFileSync(SETTINGS(), "utf8"));
  } catch {}
  if (was.page_from === REPO) return;
  fs.mkdirSync(path.dirname(SETTINGS()), { recursive: true });
  fs.writeFileSync(SETTINGS(), JSON.stringify({ ...was, page_from: REPO }, null, 2) + "\n");
}
// A login to this machine's own page (what `agentbook webui` and `agentbook up` save), which this process can serve.
export function isLocal(link) {
  if (!link?.local) return false;
  try {
    return LOOPBACK.has(new URL(link.url).hostname);
  } catch {
    return false;
  }
}

function fileEnv(file) {
  try {
    return parseEnv(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

// The page at `url` (its port is where it listens), served from this process. `grace`: not started to serve it
// (GRACE_MS).
// -> { keep(), hosting(), logIn(machine, save), setMachine(name), unlink(name) }
export function createPage({ url = pageUrl(), grace = false, log = () => {} }: { url?: string; grace?: boolean; log?: (line: string) => void } = {}) {
  const at = new URL(url);
  let waited = null;
  let mod = null;
  let broken = null;
  let hosting = false;
  let timer = null;
  let machine: string | null = null; // this machine's name, for the machines its page links to

  // The server reads its settings as it loads: its .env (AGENTBOOK_SECRET_KEY…, as bin/agentbook-server gives it
  // with --env-file; what the environment sets wins over the file), and its port. They're in
  // the environment only while it loads, and the secrets not after. With no secret key in either, the one this
  // machine keeps for itself (plugin/shared/secret-key.ts), made the first time; one set empty means none.
  // In the one-file build with the server in it (entry.ts), the server is the bundle's own, and its .env is still the
  // one beside the checkout it came from, if there is one.
  async function load() {
    const bundled = bundledServer();
    const repo = serverRepo();
    if (!repo && !bundled) throw new Error("there's no agentbook-server next to this agentbook-cli, nor where agentbook webui ran last");
    const file = Object.fromEntries(Object.entries(repo ? fileEnv(path.join(repo, ".env")) : {}).filter(([k]) => process.env[k] === undefined));
    const set: Record<string, string> = { ...file, AGENTBOOK_SERVER_PORT: at.port || "80" };
    if (process.env.AGENTBOOK_SECRET_KEY === undefined && set.AGENTBOOK_SECRET_KEY === undefined) {
      try {
        set.AGENTBOOK_SECRET_KEY = ownSecretKey();
      } catch (e) {
        log(`agentbook can't keep a secret key in ${e.path || "its file"} (${e.code || e.message}), so its page keeps no API keys or GitHub sign-ins.`);
      }
    }
    const was = Object.fromEntries(Object.keys(set).map((k) => [k, process.env[k]]));
    Object.assign(process.env, set);
    globalThis[Symbol.for("agentbook.server.embedded")] = true;
    try {
      return await (bundled ? bundled() : import(pathToFileURL(path.join(repo, "server", "main.ts")).href));
    } finally {
      for (const [k, v] of Object.entries(was)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      for (const k of SERVER_ONLY) delete process.env[k];
    }
  }

  // Loads the server (once) and listens. A port that's taken throws, as the daemon's own does: it can't go on
  // without it (crash.ts), and the next start finds what holds it. A server that can't load is said once, and
  // this daemon goes on serving its sessions without a page.
  async function host() {
    if (hosting || broken) return hosting;
    try {
      mod ??= await load();
    } catch (e) {
      broken = e;
      log(`agentbook can't serve its page here: ${e.stack || e}`);
      return false;
    }
    await mod.listen();
    hosting = true;
    tell();
    return true;
  }

  // Nothing answering at its address: ECONNREFUSED. One that's slow to answer (a loaded machine) is left be.
  const free = () =>
    fetch(`${at.origin}/api/health`, { signal: AbortSignal.timeout(2000) }).then(
      () => false,
      (e) => e.cause?.code === "ECONNREFUSED",
    );

  // Serves the page, unless something already answers at its address: then that's used, and looked at again every
  // 30 s, to serve the page here once it's gone. -> whether it's served here now.
  async function keep() {
    if (hosting || broken || timer) return hosting;
    if (grace) await (waited ??= new Promise((r) => setTimeout(r, GRACE_MS)));
    if (hosting || timer) return hosting;
    if (await free()) return host();
    log(`something already answers at ${at.origin}, an agentbook-server of its own: this uses it, and serves the page itself once it stops`);
    timer = setInterval(async () => {
      if (!(await free())) return;
      clearInterval(timer);
      timer = null;
      if (await host()) log(`its page is at ${at.origin} now, in this process`);
    }, RECHECK_MS);
    timer.unref();
    return false;
  }

  // This machine, logged in to the page it serves: now, if its person is there, else once they first sign in.
  // `save(link)` keeps the login (cli/device.json),
  // where the daemon finds it and connects.
  function logIn(machine, save) {
    if (!hosting) return;
    const saved = (got) => got && save({ server: at.origin, token: got.token, name: got.name, user: got.user, local: true });
    saved(mod.logInMachine(machine, saved));
  }

  // This machine's name, as its daemon has it: the page links to your other machines with it (server/mesh.ts).
  function tell() {
    if (!hosting || !machine) return;
    mod.setMachine?.(machine);
  }
  function setMachine(name: string) {
    machine = name;
    tell();
  }
  async function unlink(name: string) {
    if (!hosting || !mod.unlinkMesh) throw Object.assign(new Error("This machine doesn't serve its own page here, so it's linked to no other machine."), { status: 409 });
    return mod.unlinkMesh(name);
  }

  return { keep, logIn, setMachine, unlink, hosting: () => (hosting ? at.origin : null) };
}
