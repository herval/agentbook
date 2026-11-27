// Your machines, linked to each other (over iroh): every
// machine on your agentbook account, as agentbook-relay lists them, links to each other one, by its key, with no code
// and no address. Each page takes the others as machines of its person, the way it takes this machine's own
// agentbook-cli, so its feed has every machine's threads and its commands reach any of them. Nobody else's machine gets
// in: a machine connects only with a key on the account's list (iroh.ts), and the relay is asked whether a machine is
// still on the account.
//
// Linking B to A (on B as it starts, daily, and whenever another machine or the relay says something changed):
//   1. B renews its certificate with the relay, which answers with the account's machines, each with its key.
//   2. To each machine it doesn't send its threads to yet, B dials by that key over iroh and says hello: its
//      certificate, the machine it means (`to`), its page's address as browsers open it (if any) and its person, signed
//      with its key (POST /api/cli/mesh/link).
//   3. A checks the certificate against the relay's keys and its own account, that it's for the key the connection
//      proved, the signature, and with the relay that B is still on the account; makes B a machine of its person; and
//      answers with its own certificate, address and person. B checks A's certificate is for the key it dialed.
//   4. A page with nobody on it yet takes the other's person as its own (the same id, username and name), so a
//      thread's owner is the same on both. Two pages with different people for you don't link.
//   5. Each keeps the other (PeerTables), by its key, and each daemon sends its threads to the other over iroh
//      (plugin/cli/main.ts). No token: each page takes a call as the machine whose key its connection proved.
//
// What can run something goes from one page to another machine only signed with your passkey on that page, which the
// machine takes once you OK'd that page on its own (`vouch`): one Face ID on each page, for the other. The page asks
// the other page for your passkeys there (`site`), and has your passkey here sign "also take what's signed on that
// page, with these keys" for its own machine (keys.vouch), which checks it as a change of keys.
//
// A machine with no page of its own (only `agentbook login` ran there, never `agentbook webui`) links the same way, from
// its daemon (plugin/cli/mesh.ts): its hello says no page (`url` null), so no page sends it threads, and it takes what
// you sign on any page of yours without Sign once, as that page's certificate says it's yours.
//
// A machine with no iroh (not installed: npm install) links to none of your others, and Machines says why.
//
// Unlinking B (on any page, `agentbook unlink <machine>`, or the relay's page): the relay takes B off the account, the
// page that did it tells B's page (POST /api/cli/mesh/unlink), and each drops the other: its row goes (its daemon stops
// sending it threads and taking its commands, and its own machine stops taking what's signed on that page), and so
// does that machine on it, so nothing it sends is taken. What each sent stays as it was. Your other machines drop B as
// the relay next tells them: as they renew, as B next connects, or as B's page refuses them.

import { AccountTables } from "./storage/accounts.ts";
import type { UserRow } from "./storage/accounts.ts";
import { meshChanged, PeerTables } from "../plugin/shared/storage/peers.ts";
import type { PeerRow } from "../plugin/shared/storage/peers.ts";
import { machineName } from "../plugin/shared/ids.ts";
import { machineLogin, relayCall } from "../plugin/shared/machine-login.ts";
import { createAccountList, hello, LINK_PATH, pageAddress, SITE_PATH, UNLINK_PATH, type Failed } from "../plugin/shared/mesh-link.ts";
import { irohWhy, startIroh, type IrohInit, type IrohNode } from "../plugin/shared/iroh.ts";
import type { MachineLogin, RelayMachine } from "../plugin/shared/machine-login.ts";
import type { Storage } from "../plugin/shared/storage.ts";
import type { Device } from "./relay.ts";
import type { createAccounts } from "./accounts.ts";

type Accounts = ReturnType<typeof createAccounts>;

// The person both pages are, as the first one keeps them.
interface Person {
  id: string;
  username: string;
  display_name: string | null;
  bio: string | null;
  created: string;
}
// What a machine answers another's hello with: its certificate, name, page's address as browsers open it, and person
// (both null for a machine with no page: plugin/cli/mesh.ts).
export interface Linked {
  certificate: string;
  name: string;
  url: string | null;
  person: Person | null;
}
// Where your passkeys sign on a page, and their public halves, as that page says.
export interface Site {
  machine: string | null;
  origin: string;
  rp_id: string;
  keys: { id: string; alg: number; spki: string; name?: string }[];
}
// One of your account's machines this page isn't linked with yet, and why, for Machines.
export interface Unlinked {
  id: string;
  name: string;
  platform: string;
  seen: string | null;
  why: string;
}

// How often a machine renews its certificate (a week long), and hears of the account's machines, besides at start.
const RENEW_MS = Number(process.env.AGENTBOOK_RENEW_MS || 24 * 3600e3);
// A link that didn't go (a page just starting doesn't answer yet) is tried again this long after, then twice as long,
// and so on, LINK_TRIES times in all; then at the next start, renewal, or word from that machine.
const RETRY_MS = Number(process.env.AGENTBOOK_LINK_RETRY_MS || 30e3);
const LINK_TRIES = 4;


interface MeshDeps {
  storage: Storage;
  accounts: Pick<Accounts, "requestDevice" | "approveDevice" | "pollDevice" | "passkeys" | "deviceFor">;
  adopt(id: string, old: string, as: { name: string; user_id: string }): void;
  // This page's address as browsers open it (AGENTBOOK_SERVER_URL).
  publicUrl: string;
  // The account's folder, with this machine's login (machine.json), and the account this page is.
  home: string;
  account: { account: string; person: string; relay: string } | null;
  // The page took its person from another machine of theirs.
  adopted(): void;
  // A linked machine is off your account: this page drops it (unlinkHere).
  dropped(name: string): void;
  log(line: string): void;
}

export function createMesh({ storage, accounts, adopt, publicUrl, home, account, adopted, dropped, log }: MeshDeps) {
  let machine: string | null = null; // this machine's name, as its daemon says it (setMachine)
  const peers = () => storage.use(PeerTables);
  const people = () => storage.use(AccountTables);
  const saved: MachineLogin | null = account ? machineLogin(home) : null;
  // The account's machines, as the relay lists them, and this machine's login (null when it isn't on the account
  // this page is).
  const acct = saved && saved.account === account?.account ? createAccountList({ home, login: saved, log, unlinked: unlinkedHere }) : null;
  const off = () => acct?.off() ?? null;
  // This page's address as browsers open it (its own machine's, for one only it opens), for your other machines'
  // Machines and Sign once: your passkeys sign for it.
  const ownSite = pageAddress(publicUrl);
  // Why one of the account's machines isn't linked yet, by its id, as linking to it last went.
  const why = new Map<string, string>();
  const linking = new Map<string, Promise<void>>();
  let started = false;
  let said = false; // whether it said it's on the account, once
  // This machine's iroh endpoint, once it's up (start); null with none (not installed, or AGENTBOOK_IROH=0).
  let iroh: IrohNode | null = null;
  // Whether this machine sends to `row`'s: it was linked over iroh, and iroh is up here.
  const sendsTo = (row: PeerRow | null) => !!row?.key && !!iroh;
  // A call to `row`'s page, over iroh: no token, as the connection is this machine there.
  function peerFetch(row: PeerRow, path: string, init: IrohInit): Promise<Response> {
    if (!row.key || !iroh) return Promise.reject(new Error("it isn't linked over iroh"));
    return iroh.fetch(row.key, path, init);
  }

  // A machine named `name` on this page, as `uid`'s: its id and name. One of theirs with that name already is replaced
  // by it, and hands its things over, as when a machine logs in again. (It gets a token, which nothing sends: over iroh
  // the connection says which machine is calling.)
  function machineFor(name: string, uid: string): { id: string; name: string } | null {
    const r = accounts.requestDevice(name, "linked from another machine of yours");
    if (!r?.code || r.limited) return null;
    const device = accounts.approveDevice(r.code, uid);
    if (!device) return null;
    const got = accounts.pollDevice(r.poll);
    for (const old of device.replaced || []) adopt(device.id, old, { name: device.name, user_id: uid });
    return got?.token ? { id: device.id, name: device.name } : null;
  }
  // The machine `name` on this page, as `uid`'s, for one linked to it: the one by that name already, or a new one.
  function deviceHere(name: string, uid: string): { id: string; name: string } | null {
    const d = accounts.deviceFor({ name });
    return d && d.user_id === uid ? { id: d.id, name: d.name } : machineFor(name, uid);
  }

  // ---------- the person ----------
  function personHere(): UserRow | null {
    const u = account ? people().userById(account.person) : null;
    return u && !u.deleted ? u : null;
  }
  const personOf = (u: UserRow | null): Person | null => (u ? { id: u.id, username: u.username, display_name: u.display_name, bio: u.bio, created: u.created } : null);
  // This page's person, or the other page's (`p`), taken as its own when this one has nobody yet.
  function samePerson(p: unknown): { id: string } | Failed {
    const here = personHere();
    const q = p as Partial<Person> | null;
    const there = q && typeof q.id === "string" && typeof q.username === "string" && typeof q.created === "string" ? (q as Person) : null;
    if (here && there && there.id !== here.id) return { error: `Its page has another person on it for you (@${there.username}, and @${here.username} here): they link once one of the two pages has nobody on it.`, status: 409 };
    if (here) return { id: here.id };
    if (!there || !account) return { error: "Nobody has signed in on this machine's page yet: once you sign in on it, your other machines link to it.", status: 409 };
    if (!people().userById(there.id)) {
      if (people().usernameTaken(there.username)) return { error: `Someone on this page is @${there.username} already.`, status: 409 };
      people().insertUser({ id: there.id, username: there.username, display_name: there.display_name ?? null, bio: there.bio ?? null, password: "", role: "admin", created: there.created });
    }
    account.person = there.id;
    if (acct) acct.keep({ ...acct.login(), person: there.id });
    log(`mesh: this page is @${there.username}'s now, as on your other machines`);
    adopted();
    return { id: there.id };
  }

  // ---------- the relay ----------
  // Clears the addresses this machine told the relay before your machines met over iroh, if it has any there: nothing
  // asks for them now.
  async function report() {
    if (!acct || off()) return;
    const login = acct.login();
    const self = acct.machines().find((m) => m.id === login.machine);
    if (!self?.addresses?.length) return;
    try {
      const r = await relayCall(login.relay, "POST", "/machines/report", { body: { addresses: [] }, login });
      if (r.status >= 300) throw new Error(r.body.error || `HTTP ${r.status}`);
      self.addresses = [];
    } catch (e) {
      log(`mesh: couldn't clear the addresses this machine told the relay before: ${e.message}`);
    }
  }
  // The relay says this machine isn't on your account any more: it drops every machine it was linked to.
  function unlinkedHere(revoked?: string) {
    log(`mesh: the relay says this machine was taken off your agentbook${revoked ? ` on ${revoked.slice(0, 10)}` : ""}, so it drops every machine it was linked to. agentbook logout deletes what's left of it here; agentbook login puts it back`);
    for (const row of peers().list()) if (row.machine) dropped(row.name);
  }

  // ---------- linking ----------
  // Links over iroh to each machine on the account this one doesn't send to yet (or by a key it had before), and drops
  // the ones the relay took off it, and any linked before machines were the relay's, which nothing reaches now.
  // `again`: says hello to the ones it's linked to too (as the page starts: one may have a page now, or none).
  function reconcile({ again = false } = {}) {
    if (!acct || off()) return;
    const login = acct.login();
    for (const row of peers().list())
      if (!row.machine) {
        log(`mesh: ${JSON.stringify(row.name)} was linked with a code, before your machines were the relay's, so this machine drops it: they link again by themselves if it's on your account`);
        dropped(row.name);
      }
    for (const m of acct.machines()) {
      if (m.id === login.machine) continue;
      const row = peers().byMachine(m.id);
      if (m.revoked) {
        why.delete(m.id);
        if (row) {
          log(`mesh: the relay says ${JSON.stringify(row.name)} was taken off your agentbook, so this machine drops it`);
          dropped(row.name);
        }
        continue;
      }
      if (sendsTo(row) && row.key === m.key && !again) {
        why.delete(m.id);
        continue;
      }
      if (!iroh) why.set(m.id, `This machine links to none of your others: ${irohWhy() || "iroh isn't up here"}.`);
      else if (!m.key) why.set(m.id, `${m.name} has no key on the relay yet: run agentbook login on it.`);
      else void linkTo(m, m.key);
    }
  }
  // Links to `m` over iroh, by its key. One that doesn't answer (a page just starting) is tried again a few times, as
  // long as this machine doesn't send to it yet; `again`: it does, but its page doesn't take this machine (refused).
  function linkTo(m: RelayMachine, key: string, { tries = 1, again = false } = {}): Promise<void> {
    const going = linking.get(m.id);
    if (going) return going;
    const p = link(m, key)
      .then(() => void why.delete(m.id))
      .catch((e) => {
        why.set(m.id, e.message);
        log(`mesh: couldn't link to ${JSON.stringify(m.name)}: ${e.message}`);
        if (tries < LINK_TRIES)
          setTimeout(() => {
            if (!off() && (again || !sendsTo(peers().byMachine(m.id))) && !acct?.machines().find((x) => x.id === m.id)?.revoked) void linkTo(m, key, { tries: tries + 1, again });
          }, RETRY_MS * 2 ** (tries - 1)).unref();
      })
      .finally(() => linking.delete(m.id));
    linking.set(m.id, p);
    return p;
  }
  // The hello, over iroh: this machine's certificate, its page's address as browsers open it (if any) and its person,
  // signed with its key, to the page of the machine with `key`. Its answer, that machine's own, links it here too: this
  // page takes its calls on the same connection as that machine's (its certificate is for the key the connection
  // reached), so it needn't link back.
  async function link(m: RelayMachine, key: string): Promise<void> {
    if (!iroh) throw new Error(`This machine links to none of your others: ${irohWhy() || "iroh isn't up here"}.`);
    const { body, authorization } = hello(acct!.login(), m.id, { url: ownSite, person: personOf(personHere()) });
    let r: Response;
    try {
      r = await iroh.fetch(key, LINK_PATH, { method: "POST", headers: { "content-type": "application/json", authorization }, body, signal: AbortSignal.timeout(15e3) });
    } catch (e) {
      throw new Error(`This machine can't reach ${m.name} over iroh (${e.cause?.message || e.cause?.code || e.message}).`);
    }
    const got = (await r.json().catch(() => ({}))) as Partial<Linked> & { error?: string };
    if (!r.ok) throw new Error(got.error || `${m.name} answered ${r.status}.`);
    // The machine that answered is that one of your account's: its certificate says so, for the key iroh reached.
    const cert = await acct!.checkAnswer(got.certificate, m, key);
    const p = samePerson(got.person);
    if ("error" in p) throw new Error(p.error);
    const made = deviceHere(peers().byMachine(m.id)?.name ?? machineName(cert.name), p.id);
    if (!made) throw new Error("Too many machines are waiting to log in here: try again in a few minutes.");
    const site = pageAddress(got.url);
    peers().put({ name: made.name, machine: m.id, key, site });
    log(`mesh: linked to ${JSON.stringify(made.name)} over iroh: ${site ? "each sends its threads to the other" : "it has no page, so it sends its threads here and none go to it"}`);
    meshChanged.emit("changed");
  }

  // On the machine linked to: another machine of the account's hello (POST /api/cli/mesh/link), with the request's
  // Authorization header and body as sent, over iroh: `irohKey` is the calling machine's key, as its connection proved
  // it. Over HTTP (an agentbook from before iroh), it's refused.
  async function linked(authorization: string | undefined, text: string, irohKey?: string): Promise<Linked | Failed> {
    if (!acct || !account) return { error: "This machine isn't on an agentbook account, so it links to no other machine.", status: 409 };
    if (!irohKey || !iroh) return { error: "Your machines link over iroh only now: update agentbook on that one (agentbook update, then npm install).", status: 426 };
    if (!machine) return { error: "This machine's agentbook isn't ready to link machines yet: try again in a moment.", status: 503 };
    const h = await acct.checkHello(authorization, text, irohKey);
    if ("error" in h) {
      if (h.revoked) reconcile();
      return h;
    }
    const { cert, body: b } = h;
    const name = machineName(cert.name);
    if (name === machine) return { error: `That machine is called ${name}, like this one: log one of them in again with another name (agentbook login --name), and they link.`, status: 409 };
    const p = samePerson(b.person);
    if ("error" in p) return p;
    // The machine by that name here, or a new one: its calls are taken by its key, never a token.
    const made = deviceHere(name, p.id);
    if (!made) return { error: "Too many machines are waiting to log in here: try again in a few minutes.", status: 429 };
    // This machine sends to it over the same connection, as the machine this answer says (link): neither links back.
    // One that says no page has none now: nothing goes to it.
    const site = pageAddress(b.url);
    peers().put({ name: made.name, machine: cert.sub, key: irohKey, site });
    log(`mesh: ${JSON.stringify(made.name)} linked to this machine over iroh, from ${irohKey.slice(0, 8)}…: ${site ? "each sends its threads to the other" : "it has no page, so it sends its threads here and none go to it"}`);
    meshChanged.emit("changed");
    const login = acct.login();
    return { certificate: login.certificate, name: login.name, url: ownSite, person: personOf(personHere()) };
  }

  // Its page refuses this machine, as the key `key` (plugin/cli/main.ts): it dropped this machine, or lost it. The relay
  // says which: one still on the account is linked to again (and its page takes it back), one that isn't is dropped.
  async function refused({ name, key }: { name: string; key: string }) {
    const row = peers().get(name);
    if (!row || row.key !== key || !iroh) return;
    if (!row.machine) return void dropped(name);
    log(`mesh: ${JSON.stringify(name)}'s page doesn't take this machine: asking the relay whether it's still yours`);
    if (!(await acct?.machinesNow())) return;
    reconcile();
    const m = acct!.machines().find((x) => x.id === row.machine && !x.revoked);
    if (m?.key && peers().byMachine(m.id)) await linkTo(m, m.key, { again: true });
  }
  // A linked machine connected: whether it's still on your account, as the relay says (asked at most every few
  // minutes); one that isn't is dropped.
  async function check(name: string) {
    if (!acct || off() || !peers().get(name)?.machine || acct.fresh()) return;
    if (await acct.machinesNow()) reconcile();
  }
  // Takes `row`'s machine off your account on the relay, as unlinking it does: all your machines drop it.
  async function takeOff(row: PeerRow): Promise<void> {
    if (!row.machine || !acct) return;
    const login = acct.login();
    const r = await relayCall<{ revoked?: string }>(login.relay, "DELETE", `/machines/${encodeURIComponent(row.machine)}`, { login }).catch((e) => {
      throw Object.assign(new Error(`${e.message} ${row.name} is still on your agentbook.`), { status: 502 });
    });
    if (r.status !== 200 && r.status !== 404) throw Object.assign(new Error(`The relay wouldn't take ${row.name} off your agentbook (${r.body.error || `HTTP ${r.status}`}).`), { status: 502 });
    const m = acct.machines().find((x) => x.id === row.machine);
    if (m) m.revoked = r.body.revoked || new Date().toISOString();
  }
  // As the page starts (once its machine says its name): this machine on iroh, a fresh certificate and the account's
  // machines, then a link to each; again every day.
  // A renewal that didn't go (the relay asleep, or away) is tried again as a link is (RETRY_MS, twice as long each
  // time, LINK_TRIES in all); the next day's is set before each one, so one that never ends stops nothing.
  async function start() {
    if (started || !acct) return;
    started = true;
    const login = acct.login();
    // This machine on iroh, as its key: its daemon sends over it to the machines it's linked to.
    iroh = await startIroh({ key: login.key, admit: acct.admit, log, relay: login.relay });
    if (iroh) meshChanged.emit("changed");
    const again = () =>
      setTimeout(() => {
        again();
        void onAccount();
      }, RENEW_MS).unref();
    again();
    await onAccount(1, { again: true });
  }
  async function onAccount(tries = 1, { again = false } = {}) {
    if (await acct!.renew()) {
      await report();
      const login = acct!.login();
      const others = acct!.machines().filter((m) => m.id !== login.machine && !m.revoked).length;
      if (tries > 1 || !said) log(`mesh: on your agentbook account as ${JSON.stringify(login.name)}${ownSite ? `, at ${ownSite}` : ""}; ${others} other machine${others === 1 ? "" : "s"} on it`);
      said = true;
    } else if (!off() && tries < LINK_TRIES) {
      setTimeout(() => void onAccount(tries + 1, { again }), RETRY_MS * 2 ** (tries - 1)).unref();
    }
    reconcile({ again });
  }
  // Your account's machines this page isn't linked with, and why.
  function others(): Unlinked[] {
    if (!acct) return [];
    const login = acct.login();
    return acct
      .machines()
      .filter((m) => m.id !== login.machine && !m.revoked && !peers().byMachine(m.id))
      .map((m) => ({ id: m.id, name: m.name, platform: m.platform, seen: m.seen, why: off() ? "This machine was taken off your agentbook." : why.get(m.id) || (linking.has(m.id) ? "Linking now." : "Not linked yet: they link as either one next starts.") }));
  }

  // On the machine linked to: the page your passkeys sign on here, and their public halves, for a machine linked to
  // this one to have its own take what you sign here (GET /api/cli/mesh/site, over iroh).
  function site(D: Device, uid: string): Site | Failed {
    if (!peers().get(D.name)) return { error: "Only a machine linked to this one asks for its passkeys.", status: 403 };
    const url = new URL(publicUrl);
    const keys = accounts.passkeys(uid).map(({ id, alg, spki, name }) => ({ id, alg, spki, ...(name ? { name } : {}) }));
    return { machine, origin: url.origin, rp_id: url.hostname, keys };
  }

  // On the page of the machine that's to take another page's signatures: what to have it take for the linked machine
  // `name`, as that machine's page says, or why not.
  async function siteOf(name: string): Promise<Site | Failed> {
    const row = peers().get(machineName(name));
    if (!row) return { error: `${name} isn't linked to this machine.`, status: 404 };
    if (!row.site) return { error: `${row.name} has no page: it takes what you sign on this one by itself.`, status: 409 };
    if (!sendsTo(row)) return { error: `This machine doesn't reach ${name}'s page.`, status: 409 };
    let r: Response;
    try {
      r = await peerFetch(row, SITE_PATH, { signal: AbortSignal.timeout(15e3) });
    } catch (e) {
      return { error: `Can't reach ${name} over iroh: ${e.cause?.message || e.message}`, status: 502 };
    }
    const got = (await r.json().catch(() => ({}))) as Partial<Site> & { error?: string };
    if (!r.ok) return { error: `${name}'s page answered: ${got.error || r.status}`, status: 502 };
    if (typeof got.origin !== "string" || typeof got.rp_id !== "string" || !Array.isArray(got.keys)) return { error: `${name}'s page didn't answer as an agentbook page does.`, status: 502 };
    if (!got.keys.length) return { error: `You have no passkey on ${name}'s page yet: make one there (${row.site ? `${row.site}, ` : ""}on your profile), then sign here again.`, status: 409 };
    return { machine: got.machine ?? null, origin: got.origin, rp_id: got.rp_id, keys: got.keys };
  }

  // Unlinking `name`: this machine stops sending it its threads and taking its commands (its row goes, and with it its
  // uplink there and what its own machine takes signed on that page: plugin/cli/main.ts). -> its row as it was, or
  // null for a machine that wasn't linked.
  function forget(name: string): PeerRow | null {
    const row = peers().get(machineName(name));
    if (!row) return null;
    peers().remove(row.name);
    // Its connection closes a moment later, not at once: this may be the answer to its own unlink, going out on it.
    if (row.key)
      setTimeout(() => {
        if (!peers().list().some((r) => r.key === row.key)) iroh?.drop(row.key);
      }, 2000).unref();
    log(`mesh: unlinked from ${JSON.stringify(row.name)}`);
    meshChanged.emit("changed");
    return row;
  }
  // Tells `row`'s page this machine unlinks it, over iroh, so that page does the same. -> whether it heard (an answer of
  // 2xx).
  async function tell(row: PeerRow): Promise<boolean> {
    if (!sendsTo(row)) return false;
    try {
      const r = await peerFetch(row, UNLINK_PATH, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(10e3) });
      return r.ok;
    } catch {
      return false;
    }
  }

  return {
    start,
    linked,
    refused,
    check,
    takeOff,
    others,
    site,
    siteOf,
    forget,
    tell,
    // Asks the relay for your machines, and links to whatever this machine doesn't send to yet (a person came to this
    // page, so the ones that wouldn't link to a page with nobody on it do now).
    nudge: async () => {
      if (await acct?.machinesNow()) reconcile();
    },
    // Asks the relay now, then links and drops as it says (this machine was told it's unlinked).
    refresh: async () => {
      if (await acct?.renew()) reconcile();
    },
    // Why a machine linked to this one isn't linked both ways, or null.
    whyOf: (name: string): string | null => {
      const row = peers().get(machineName(name));
      return row?.machine && !sendsTo(row) ? why.get(row.machine) || null : null;
    },
    // A machine linked to this one, or null.
    get: (name: string): PeerRow | null => peers().get(machineName(name)),
    machine: () => machine,
    // This machine's name, as its daemon says it: the page links to your other machines then.
    setMachine: (name: string) => {
      machine = machineName(name);
      void start();
    },
    // The machines this one is linked to: where each one's page is as browsers open it (`site`, if anywhere), whether
    // this machine sends to it over iroh (it's up here), and how that goes now (`path`: "direct", "relay", or null while
    // they aren't connected).
    list: () => peers().list().map(({ name, site, key, added }) => ({ name, site, iroh: !!(key && iroh), path: key && iroh ? iroh.path(key) : null, added })),
    // Why this machine isn't on iroh, when it should be, or null.
    irohWhy: () => (acct && !iroh ? irohWhy() : null),
  };
}
