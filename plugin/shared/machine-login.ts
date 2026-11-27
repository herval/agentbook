// This machine's login to its person's account on agentbook-relay, as `agentbook login` saved it: in the account's
// own folder, machine.json, only its owner may read it.
//
//   relay         the relay it logged in through
//   account       the relay's id for the person's account (the `acct` its sign-ins carry)
//   person        the page's person: their user id here, the account's id unless the data folder had one before
//   machine       this machine's id on the relay; name, its name there
//   certificate   the relay's word that this machine, with this key, is the account's (7 days; expires_at)
//   key           the machine's Ed25519 key (a JWK's x and d), which never leaves this file
//   machines      the account's machines, as the relay said last
//
// Accounts live in ~/.agentbook/accounts/<account>/ (AGENTBOOK_ROOT for another root), one folder each, which is
// AGENTBOOK_HOME for everything agentbook runs for that account. accounts.json there names the default: the one a
// command, a hook or the page runs as when AGENTBOOK_HOME doesn't say (plugin/cli/main.mjs, ./home.ts). The one
// exception: a machine with agentbook's data from before accounts keeps it where it is, and the root itself is the
// folder of the account it logs in to (its machine.json at the top, beside the rest).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { MACHINE_FILE, ROOT, accountHome, accountIn, defaultAccount } from "./home.ts";
import { machineAuthorization } from "./relay-verify.ts";
import { pagePersonIn, usersIn } from "./storage/before.ts";

export { MACHINE_FILE, ROOT, accountHome, defaultAccount };

export interface MachineLogin {
  relay: string;
  account: string;
  person: string;
  machine: string;
  name: string;
  certificate: string;
  expires_at: string;
  key: { x: string; d: string };
  machines: RelayMachine[];
}
// One of the account's machines, as the relay lists them: unlinked ones too (`revoked`), so the others drop them.
// `addresses`: where its page answers, as it last said (POST /machines/report).
export interface RelayMachine {
  id: string;
  name: string;
  platform: string;
  key: string;
  addresses: string[];
  linked: string;
  seen: string | null;
  revoked: string | null;
}

export const ACCOUNTS = (root = ROOT) => path.join(root, "accounts");
// The relay agentbook logs in through, unless AGENTBOOK_RELAY_URL says another (the tests' own).
export const DEFAULT_RELAY = "https://agentbook-relay.fly.dev";
export const relayUrl = () => (process.env.AGENTBOOK_RELAY_URL || DEFAULT_RELAY).replace(/\/+$/, "");

export function machineLogin(home: string): MachineLogin | null {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(home, MACHINE_FILE), "utf8")) as MachineLogin;
    return m && typeof m.account === "string" && typeof m.certificate === "string" ? m : null;
  } catch {
    return null;
  }
}
export function saveMachineLogin(home: string, login: MachineLogin) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = path.join(home, MACHINE_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(login, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}
// A call to the relay, signed with the machine's key when `login` is given (the routes after /device/token). It
// answers or fails within RELAY_MS, the answer read too, by a timer of its own: a page that started as the relay
// woke (it sleeps when nobody uses it) once waited on a call that never ended, so it never renewed.
const RELAY_MS = Number(process.env.AGENTBOOK_RELAY_TIMEOUT_MS || 15e3);
export async function relayCall<T>(relay: string, method: string, p: string, { body, login }: { body?: unknown; login?: Pick<MachineLogin, "machine" | "key"> } = {}): Promise<{ status: number; body: T & { error?: string } }> {
  const text = body === undefined ? "" : JSON.stringify(body);
  const headers: Record<string, string> = body === undefined ? {} : { "content-type": "application/json" };
  if (login) headers.authorization = machineAuthorization({ machine: login.machine, privateKey: machineKey(login), method, path: p, body: text });
  const stop = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      stop.abort();
      reject(new Error(`agentbook's relay at ${relay} didn't answer in ${Math.round(RELAY_MS / 1000)} s.`));
    }, RELAY_MS);
  });
  const call = (async () => {
    const r = await fetch(relay + p, { method, headers, body: body === undefined ? undefined : text, signal: stop.signal }).catch((e) => {
      throw new Error(`Can't reach agentbook's relay at ${relay}: ${e.cause?.code || e.message}.`);
    });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as T & { error?: string } };
  })();
  try {
    return await Promise.race([call, late]);
  } finally {
    clearTimeout(timer);
    call.catch(() => {});
  }
}
export const machineKey = (login: Pick<MachineLogin, "key">) => crypto.createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", x: login.key.x, d: login.key.d }, format: "jwk" });
// A new key for a machine logging in: its public half (`x`, what the relay keeps) and the private one.
export function newMachineKey(): { x: string; d: string } {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" });
  return { x: String(jwk.x), d: String(jwk.d) };
}

// The default account (accounts.json, defaultAccount in ./home.ts), and the accounts there are.
export function setDefaultAccount(account: string | null, root = ROOT) {
  fs.mkdirSync(ACCOUNTS(root), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(ACCOUNTS(root), "accounts.json"), JSON.stringify({ default: account }, null, 2) + "\n", { mode: 0o600 });
}
const real = (p: string) => {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
};
export const sameFolder = (a: string, b: string) => real(a) === real(b);
// agentbook's data from before accounts, in the root itself, which becomes the folder of the first account the machine
// logs in to, where it is: a page that has people (its database, from before the split or since), or a machine logged
// in to a page. A machine that ran here logged in to nothing kept nothing, and isn't that.
const PAGE_DATABASES = ["storage.db", "agentbook.db", "server/storage.db", "server/agentbook.db"];
export const dataBefore = (root = ROOT) => fs.existsSync(path.join(root, "cli", "device.json")) || PAGE_DATABASES.some((f) => usersIn(path.join(root, f)) > 0);
// The person of the page in that data, who becomes the account's person, with their user id: what they made stays
// theirs. Null for a machine that was logged in to a page elsewhere, which has none.
export function pagePersonBefore(root = ROOT): { id: string; username: string } | null {
  for (const f of PAGE_DATABASES) {
    const p = pagePersonIn(path.join(root, f));
    if (p) return p;
  }
  return null;
}
// What agentbook keeps at the top of its folder, and logging out deletes when that folder is the root, which can hold
// more: other accounts' folders, another app's (agentbook v2 keeps node/ and dev/ there).
const OWN = new Set([MACHINE_FILE, "cli", "server", "hub.json", "events.jsonl", "plugin-copies", "files", "openclaw.json", "groups", "routine-code", "steer", "pages", "paused", "routines", "routine-drafts"]);
export const ownEntries = (dir: string): string[] => fs.readdirSync(dir).filter((n) => OWN.has(n) || /^(storage|agentbook)\.db($|-wal$|-shm$|\.)/.test(n) || /^[\w.-]+\.log$/.test(n));
// A machine on nobody's account: agentbook runs in the root itself (no account's folder given or picked), which has
// no login and no data from before.
export const onNoAccount = (home: string, root = ROOT) => sameFolder(home, root) && !machineLogin(home) && !dataBefore(root);

export function accountsIn(root = ROOT): string[] {
  const here = accountIn(root);
  let theirs: string[] = [];
  try {
    theirs = fs.readdirSync(ACCOUNTS(root)).filter((a) => a !== here && fs.existsSync(path.join(ACCOUNTS(root), a, MACHINE_FILE)));
  } catch {}
  return here ? [here, ...theirs] : theirs;
}
