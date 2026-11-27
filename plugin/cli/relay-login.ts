// `agentbook login` and `agentbook logout`, through agentbook-relay (its PROTOCOL.md, 5–7). Login makes the machine a
// key, asks the relay for a code, and waits while its person says yes on the relay's page; it gets back a certificate
// saying the machine is their account's, and keeps it, with the key, in the account's folder
// (plugin/shared/machine-login.ts). Logout takes the machine off the account on the relay, then deletes that folder:
// everything agentbook keeps for that person here.
//
// A machine with agentbook's data from before accounts keeps it where it is: the root becomes the folder of the
// account it logs in to, and the page's person there the account's person, by their user id, so everything they made
// stays theirs. Nothing moves (absolute paths to it are kept in its data, and running sessions load from it); deleting
// machine.json undoes it. Logging out of that account deletes only what's agentbook's there.
//
// commands.ts runs these, and starts or stops agentbook around them.

import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { machineName } from "../shared/ids.ts";
import { createGate } from "./gate.ts";
import { createVerifier, deviceProofInput } from "../shared/relay-verify.ts";
import { ACCOUNTS, MACHINE_FILE, ROOT, accountHome, accountsIn, dataBefore, defaultAccount, machineKey, machineLogin, newMachineKey, ownEntries, pagePersonBefore, relayCall, relayUrl, sameFolder, saveMachineLogin, setDefaultAccount, type MachineLogin, type RelayMachine } from "../shared/machine-login.ts";
import crypto from "node:crypto";

type Print = (line: string) => void;
interface Linked {
  account: string;
  machine: string;
  name: string;
  certificate: string;
  expires_at: string;
  machines: RelayMachine[];
}

const real = (p: string) => {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
};
const when = (iso: string) => new Date(iso).toISOString().slice(0, 10);

// Where this login goes: AGENTBOOK_HOME when it's an account's folder of its own (a test's, or one the front runs),
// else a new folder for the account under the root's accounts/.
function placeFor(home: string, root: string): "home" | "root" {
  return sameFolder(home, root) ? "root" : "home";
}

// `onCode`: the code and the relay's page for it, as they're printed, for a page to show them (first-run.ts).
export async function relayLogin(args: string[], { print, home, root = ROOT, open, onCode }: { print: Print; home: string; root?: string; open?: (url: string) => void; onCode?: (d: { code: string; url: string }) => void }): Promise<{ login: MachineLogin; home: string; renewed: boolean; said: string }> {
  const relay = relayUrl();
  const had = machineLogin(home);
  // Signed in already: a fresh certificate, and the account's machines as the relay has them now.
  if (had) {
    const r = await relayCall<Linked & { revoked?: string }>(had.relay || relay, "POST", "/machines/renew", { login: had });
    if (r.status === 403 && r.body.error === "unlinked")
      throw new Error(`${had.name} was unlinked from your agentbook${r.body.revoked ? ` on ${when(r.body.revoked)}` : ""}. agentbook logout deletes what's left of it here; agentbook login then links it again.`);
    if (r.status !== 200) throw new Error(`The relay wouldn't renew ${had.name}'s certificate (${r.body.error || `HTTP ${r.status}`}).`);
    const login = { ...had, certificate: r.body.certificate, expires_at: r.body.expires_at, machines: r.body.machines, name: r.body.name || had.name };
    saveMachineLogin(home, login);
    return { login, home, renewed: true, said: `Already signed in: ${login.name} is your agentbook's. Its certificate is good until ${when(login.expires_at)}.` };
  }
  const place = placeFor(home, root);
  const before = place === "root" && dataBefore(root) ? { person: pagePersonBefore(root) } : null;
  const asked = args.includes("--name") ? args[args.indexOf("--name") + 1] : null;
  const name = machineName(asked || process.env.AGENTBOOK_MACHINE || os.hostname().split(".")[0]);
  const key = newMachineKey();
  const page = `http://127.0.0.1:${Number(process.env.AGENTBOOK_SERVER_PORT || 4310)}`;
  const start = await relayCall<{ device_code: string; user_code: string; verification_uri: string; verification_uri_complete: string; expires_in: number; interval: number }>(relay, "POST", "/device", { body: { key: key.x, name, platform: process.platform, page } });
  if (start.status === 429) throw new Error("Too many machines are waiting to be added from this network. Try again in a few minutes.");
  if (start.status !== 200) throw new Error(`The relay wouldn't start a login (${start.body.error || `HTTP ${start.status}`}).`);
  const d = start.body;
  print(`To add ${name} to your agentbook, open this, sign in, and check it shows ${d.user_code}:\n\n    ${d.verification_uri_complete}\n\nWaiting for you…`);
  onCode?.({ code: d.user_code, url: d.verification_uri_complete });
  if (!args.includes("--no-open")) open?.(d.verification_uri_complete);
  const privateKey = machineKey({ key });
  const sig = crypto.sign(null, deviceProofInput(d.device_code), privateKey).toString("base64url");
  let every = Math.max(1, Number(d.interval) || 2) * 1000;
  const until = Date.now() + (Number(d.expires_in) || 600) * 1000;
  while (Date.now() < until) {
    await sleep(every);
    const r = await relayCall<Linked>(relay, "POST", "/device/token", { body: { device_code: d.device_code, sig } }).catch(() => null);
    if (!r) continue;
    const error = r.body.error;
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      every += 5000;
      continue;
    }
    if (error === "access_denied") throw new Error(`You said no on the relay's page, so ${name} isn't on your agentbook. Nothing changed here.`);
    if (error === "expired_token") throw new Error("The code ran out before anyone said yes. Run agentbook login again.");
    if (r.status !== 200) throw new Error(`The relay wouldn't add ${name} (${error || `HTTP ${r.status}`}). Run agentbook login again.`);
    // The relay's word, checked as every other machine of the account will check it: signed by the relay, for this key.
    const cert = await createVerifier({ relay }).verifyMachine(r.body.certificate);
    if (cert.key !== key.x || cert.acct !== r.body.account || cert.sub !== r.body.machine) throw new Error("The relay's certificate isn't for this machine's key. Nothing was saved; run agentbook login again.");
    const to = before ? root : place === "root" ? accountHome(r.body.account, root) : home;
    if (place === "root" && machineLogin(to)) throw new Error(`This machine is signed in to that account already, in ${to}.`);
    const login: MachineLogin = { relay, account: r.body.account, person: before?.person?.id || r.body.account, machine: r.body.machine, name: r.body.name || name, certificate: r.body.certificate, expires_at: r.body.expires_at, key, machines: r.body.machines || [] };
    saveMachineLogin(to, login);
    if (place === "root" && !defaultAccount(root)) setDefaultAccount(login.account, root);
    if (!before) holdPast(to);
    const kept = before ? ` agentbook's data on it stays where it is, in ${root}, and is your account's now${before.person ? `: you're @${before.person.username} there, as before` : ""}.` : "";
    return { login, home: to, renewed: false, said: `Signed in: ${login.name} is on your agentbook now.${kept}` };
  }
  throw new Error("Nobody said yes in time. Run agentbook login again.");
}

// A machine new to agentbook keeps what its agents did before here, and Codex's settings as they are, until its
// person says on their page's welcome card how much goes up (plugin/cli/history.ts). One that said already (a login
// before, agentbook-cli login's questions) keeps what it said.
function holdPast(home: string) {
  const gate = createGate({ home });
  const s = gate.settings();
  if (s.history_from !== undefined || s.history_pick !== undefined) return;
  gate.agree({ history_pick: "pending", history_from: new Date().toISOString(), ...(s.codex_tools === undefined ? { codex_tools: false } : {}) });
}

// Logging out: what goes, said first, and a yes for it (the machine's name typed, or --yes); then the relay takes the
// machine off the account, and the folder goes. `stop`: agentbook running on it, stopped before its folder goes.
export async function relayLogout(args: string[], { print, home, root = ROOT, stop }: { print: Print; home: string; root?: string; stop: () => Promise<unknown> }): Promise<string> {
  const login = machineLogin(home);
  if (!login) throw new Error("This machine isn't signed in to an agentbook account.");
  // The root, where an account's data from before accounts stayed, loses only what's agentbook's. Any other folder
  // goes whole, but never one that holds other accounts', or the home folder itself.
  const inRoot = sameFolder(home, root);
  if (!inRoot && (fs.existsSync(ACCOUNTS(home)) || real(home) === real(os.homedir()) || real(home) === "/")) throw new Error(`${home} holds more than this account, so logging out won't delete it.`);
  const stays = inRoot ? fs.readdirSync(home).filter((n) => !ownEntries(home).includes(n) && n !== ".DS_Store") : [];
  const what = inRoot ? `in ${home}, ${ownEntries(home).join(", ")}` : home;
  print(`Logging out takes ${login.name} off your agentbook, and deletes everything agentbook keeps for you on it: ${what}.${stays.length ? ` The rest of ${home} stays (${stays.join(", ")}).` : ""} Your agents' own files (~/.claude, ~/.codex) and your repos stay.`);
  if (!args.includes("--yes")) {
    if (!process.stdin.isTTY) throw new Error("Nothing was deleted: run agentbook logout --yes to go on without being asked.");
    const ask = createInterface({ input: process.stdin, output: process.stdout });
    const typed = (await ask.question(`Type ${login.name} to log out and delete it: `).finally(() => ask.close())).trim();
    if (typed !== login.name) return "Nothing changed.";
  }
  const offline = args.includes("--offline");
  const r = await relayCall<{ revoked?: string }>(login.relay, "DELETE", `/machines/${encodeURIComponent(login.machine)}`, { login }).catch((e) => {
    if (offline) return null;
    throw new Error(`${e.message} Nothing was deleted. Run it again online, or with --offline to delete it here anyway: your other machines take ${login.name} until its certificate runs out, on ${when(login.expires_at)}.`);
  });
  // Unlinked already (from another machine, or the relay's page), or the relay doesn't know it: it's off either way.
  if (r && r.status !== 200 && r.body.error !== "unlinked" && r.status !== 401 && r.status !== 404) throw new Error(`The relay wouldn't take ${login.name} off your account (${r.body.error || `HTTP ${r.status}`}). Nothing was deleted.`);
  await stop();
  if (inRoot) {
    // Its login last: stopped halfway, the machine is still logged in, and logging out again finishes.
    for (const n of ownEntries(home).filter((n) => n !== MACHINE_FILE)) fs.rmSync(path.join(home, n), { recursive: true, force: true });
    fs.rmSync(path.join(home, MACHINE_FILE), { force: true });
  } else fs.rmSync(home, { recursive: true, force: true });
  // The default goes to another account of this machine's, if there's one.
  if (defaultAccount(root) === null && fs.existsSync(ACCOUNTS(root)) && (inRoot || real(path.dirname(home)) === real(ACCOUNTS(root)))) setDefaultAccount(accountsIn(root)[0] ?? null, root);
  const after = r ? "" : ` The relay wasn't told, so your other machines take ${login.name} until its certificate runs out, on ${when(login.expires_at)}: Unlink it on the relay's page (${login.relay}) to stop that sooner.`;
  return `Logged out: ${login.name} is off your agentbook, and what agentbook kept for you here is deleted.${after}`;
}
