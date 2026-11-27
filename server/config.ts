// agentbook-server's settings, from its environment: where it keeps its data, where it listens, and the address
// people reach it at. Its own: a machine's agentbook-cli has its settings in plugin/lib/common.ts.

import fs from "node:fs";
import path from "node:path";
import { machineLogin } from "../plugin/shared/machine-login.ts";
import { HOME as AGENTBOOK_HOME } from "../plugin/shared/home.ts";

// Its data folder: AGENTBOOK_SERVER_HOME, else server/ in agentbook's data folder (~/.agentbook/server).
export const SERVER_HOME = process.env.AGENTBOOK_SERVER_HOME || path.join(AGENTBOOK_HOME, "server");
// Where its storage is (plugin/shared/storage.ts: one database for all agentbook keeps there, storage.db): in
// agentbook's data folder when its own is server/ in it, the usual, so the page and this machine's agentbook-cli keep
// one database between them; else in its own (AGENTBOOK_SERVER_HOME elsewhere: a hub, a test's). Both by way of
// server/, which it may read under Node's permission model, where the data folder itself it may not (macOS's /var).
const real = (p: string): string => {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
};
export const STORAGE_ROOT = real(SERVER_HOME) === real(path.join(AGENTBOOK_HOME, "server")) ? AGENTBOOK_HOME : SERVER_HOME;
export const PORT = Number(process.env.AGENTBOOK_SERVER_PORT || 4310);
export const HOST = process.env.AGENTBOOK_SERVER_HOST || "127.0.0.1";
// The address people and machines reach it at, for the links it makes: AGENTBOOK_SERVER_URL (behind a proxy, a
// tailnet name), else where it listens.
export const PUBLIC_URL = (process.env.AGENTBOOK_SERVER_URL || `http://${HOST === "0.0.0.0" || HOST === "::" ? "localhost" : HOST}:${PORT}`).replace(/\/$/, "");
// Where agents' HTML previews are served from, if not here: AGENTBOOK_PREVIEW_URL (preview.agentbook.example), the
// same server under another name, so a post's page could never be on the page's own origin, even outside its
// sandbox. That name serves previews and nothing else.
export const PREVIEW_URL = (process.env.AGENTBOOK_PREVIEW_URL || "").replace(/\/$/, "") || null;
// The account this page is: its machine's login (`agentbook login`,
// plugin/shared/machine-login.ts), in agentbook's data folder. Only that account signs in here, as its person
// (`person`, their user id). Under Node's permission model the server may read that file and no other there
// (test/harness-front.ts). Without one, nobody signs in (the tests make people through their own route,
// server/api/test-people.ts).
const LOGIN = machineLogin(AGENTBOOK_HOME);
export const PAGE_MACHINE_ID = LOGIN?.machine || null;
export const ACCOUNT = LOGIN ? { account: LOGIN.account, person: LOGIN.person || LOGIN.account, relay: LOGIN.relay } : null;
// The sign-in relay (agentbook-relay): AGENTBOOK_RELAY_URL, else the one the machine logged in through. The account's
// person signs in with Google through it (./api/signin.ts, plugin/shared/relay-verify.ts).
export const SIGNIN_RELAY = (process.env.AGENTBOOK_RELAY_URL || LOGIN?.relay || "").replace(/\/+$/, "") || null;
// The ones the page offers (the relay's /.well-known/agentbook-relay says which it has).
export const RELAY_PROVIDERS = [{ id: "google", name: "Google" }];
// Behind a proxy that sets the client's address (Fly, Caddy, nginx): AGENTBOOK_TRUST_PROXY=1, and the server takes
// each request's address from Fly-Client-IP or X-Forwarded-For, for the sign-in limits. Off, those headers are
// ignored: anyone can send them.
export const TRUST_PROXY = /^(1|true|yes|fly)$/i.test(process.env.AGENTBOOK_TRUST_PROXY || "");
// For the privacy note (/privacy): who runs this server, and whom to ask about it. Plain text; both optional.
export const OPERATOR = String(process.env.AGENTBOOK_OPERATOR || "").trim() || null;
export const CONTACT = String(process.env.AGENTBOOK_CONTACT || "").trim() || null;
// The newest agentbook-cli people can install (AGENTBOOK_CLI_LATEST=0.3.40): machines on an older one hear the
// number, and one that updates itself then does. It's set by hand, and not this server's own version, which can run
// ahead of what's published. Unset, or not a version, nobody's told anything.
const isVersion = (v: string) => /^\d+(\.\d+)*$/.test(v) && v.length <= 40;
const latest = String(process.env.AGENTBOOK_CLI_LATEST || "").trim();
export const CLI_LATEST = isVersion(latest) ? latest : null;
// The same, said to a running server: `agentbook-server cli-latest <version>` writes it in the data folder, where it
// outlives a restart and comes before the variable. Saying it is the moment every machine that updates itself moves,
// so it comes after the server's own side of a release. Read again only when the file changes.
export const CLI_LATEST_FILE = path.join(SERVER_HOME, "cli-latest");
let said: { mtime: number; value: string | null } = { mtime: -1, value: null };
export function cliLatest(): string | null {
  let mtime = 0;
  try {
    mtime = fs.statSync(CLI_LATEST_FILE).mtimeMs;
  } catch {}
  if (mtime !== said.mtime) {
    let v = "";
    try {
      v = mtime ? fs.readFileSync(CLI_LATEST_FILE, "utf8").trim() : "";
    } catch {}
    said = { mtime, value: isVersion(v) ? v : null };
  }
  return said.value || CLI_LATEST;
}
export function setCliLatest(v: string | null): void {
  if (v == null) return fs.rmSync(CLI_LATEST_FILE, { force: true });
  if (!isVersion(v)) throw new Error(`${v} isn't a version`);
  fs.mkdirSync(SERVER_HOME, { recursive: true });
  fs.writeFileSync(CLI_LATEST_FILE, `${v}\n`, { mode: 0o600 });
}
