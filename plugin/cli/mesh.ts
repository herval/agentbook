// A machine on your account that serves no page of its own (`agentbook login` ran there, `agentbook webui` never did:
// a headless Mac, a server): it links to your pages by itself, over iroh, as server/mesh.ts links one page to another,
// and its daemon sends them its threads and takes their commands (main.ts).
//
// - It's on iroh as its login's key, and lets in only the account's machines, as the relay lists them.
// - It says hello to each machine on the account, as it starts and as it renews its certificate daily, saying it has
//   no page (`url` null), so no page sends it threads; and it answers their hellos the same way. A machine that answers
//   with no page either isn't kept: two machines with no page have nothing to send each other.
// - Its iroh endpoint answers the hello and an unlink, and nothing else: whatever else is asked of it comes as a
//   command, over the uplink it keeps to that page, which its gate checks as from elsewhere.
// - It takes what you sign on any page of yours, as every machine does (page-keys.ts).

import http from "node:http";
import { machineName } from "../shared/ids.ts";
import { irohServe, irohWhy, startIroh, type IrohNode, type IrohSocket } from "../shared/iroh.ts";
import { machineLogin, type RelayMachine } from "../shared/machine-login.ts";
import { createAccountList, hello, LINK_PATH, pageAddress, UNLINK_PATH, type AccountList, type Failed } from "../shared/mesh-link.ts";
import { meshChanged, PeerTables } from "../shared/storage/peers.ts";
import type { PeerRow } from "../shared/storage/peers.ts";

// How often it renews its certificate (a week long), and hears of the account's machines, besides at start.
const RENEW_MS = Number(process.env.AGENTBOOK_RENEW_MS || 24 * 3600e3);
// A link that didn't go is tried again this long after, then twice as long, LINK_TRIES times in all.
const RETRY_MS = Number(process.env.AGENTBOOK_LINK_RETRY_MS || 30e3);
const LINK_TRIES = 4;

interface Deps {
  // The account's folder, with this machine's login (machine.json).
  home: string;
  peers: () => PeerTables;
  // This machine's name.
  machine: string;
  log: (line: string) => void;
  // A page said whose machine this is (its person's username).
  owner: (username: string) => void;
}

export function createCliMesh({ home, peers, machine, log, owner }: Deps) {
  const login = machineLogin(home);
  let acct: AccountList | null = null;
  let iroh: IrohNode | null = null;
  let started = false;
  // Why each of the account's machines isn't linked, by its id.
  const why = new Map<string, string>();
  const linking = new Map<string, Promise<void>>();

  const drop = (row: PeerRow, said: string) => {
    peers().remove(row.name);
    log(`mesh: ${said}`);
    setTimeout(() => {
      if (row.key && !peers().list().some((r) => r.key === row.key)) iroh?.drop(row.key);
    }, 2000).unref();
    meshChanged.emit("changed");
  };
  function unlinkedHere(revoked?: string) {
    log(`mesh: the relay says this machine was taken off your agentbook${revoked ? ` on ${revoked.slice(0, 10)}` : ""}, so it drops every page it was linked to. agentbook logout deletes what's left of it here; agentbook login puts it back`);
    for (const row of peers().list()) drop(row, `unlinked from ${JSON.stringify(row.name)}`);
  }

  // ---------- its pages ----------
  // A page's person, from what it said: their username, for whose machine this is.
  const ownerOf = (person: unknown) => {
    const u = (person as { username?: unknown } | null)?.username;
    if (typeof u === "string" && u) owner(u);
  };
  function keep(cert: { sub: string; name: string }, key: string, site: string): PeerRow | Failed {
    const was = peers().byMachine(cert.sub);
    const name = was?.name ?? machineName(cert.name);
    if (name === machine) return { error: `That machine is called ${name}, like this one: log one of them in again with another name (agentbook login --name), and they link.`, status: 409 };
    peers().put({ name, machine: cert.sub, key, site, added: was?.added });
    if (!was || was.key !== key || was.site !== site) log(`mesh: linked to ${JSON.stringify(name)} over iroh: this machine sends its threads to its page, ${site}`);
    meshChanged.emit("changed");
    return peers().get(name)!;
  }
  // Links over iroh to each machine on the account (`again`: those it's linked to too, so each hears it has no page),
  // and drops the ones the relay took off it.
  function reconcile({ again = false } = {}) {
    if (!acct || acct.off()) return;
    const self = acct.login().machine;
    for (const m of acct.machines()) {
      if (m.id === self) continue;
      const row = peers().byMachine(m.id);
      if (m.revoked) {
        why.delete(m.id);
        if (row) drop(row, `the relay says ${JSON.stringify(row.name)} was taken off your agentbook, so this machine drops it`);
        continue;
      }
      if (row && row.key === m.key && !again) continue;
      if (!iroh) why.set(m.id, `This machine links to none of your others: ${irohWhy() || "iroh isn't up here"}.`);
      else if (!m.key) why.set(m.id, `${m.name} has no key on the relay yet: run agentbook login on it.`);
      else void linkTo(m, m.key);
    }
  }
  function linkTo(m: RelayMachine, key: string, tries = 1): Promise<void> {
    const going = linking.get(m.id);
    if (going) return going;
    const p = link(m, key)
      .then(() => void why.delete(m.id))
      .catch((e) => {
        why.set(m.id, e.message);
        if (e.final) return;
        log(`mesh: couldn't link to ${JSON.stringify(m.name)}: ${e.message}`);
        if (tries < LINK_TRIES)
          setTimeout(() => {
            if (acct && !acct.off() && !peers().byMachine(m.id) && !acct.machines().find((x) => x.id === m.id)?.revoked) void linkTo(m, key, tries + 1);
          }, RETRY_MS * 2 ** (tries - 1)).unref();
      })
      .finally(() => linking.delete(m.id));
    linking.set(m.id, p);
    return p;
  }
  // The hello to `m`, dialed by its key: this machine's certificate, no page and no person. A page's answer links it.
  async function link(m: RelayMachine, key: string): Promise<void> {
    if (!iroh || !acct) throw new Error(`This machine links to none of your others: ${irohWhy() || "iroh isn't up here"}.`);
    const { body, authorization } = hello(acct.login(), m.id, { url: null, person: null });
    let r: Response;
    try {
      r = await iroh.fetch(key, LINK_PATH, { method: "POST", headers: { "content-type": "application/json", authorization }, body, signal: AbortSignal.timeout(15e3) });
    } catch (e) {
      throw new Error(`This machine can't reach ${m.name} over iroh (${e.cause?.message || e.cause?.code || e.message}).`);
    }
    const got = (await r.json().catch(() => ({}))) as { certificate?: string; url?: string | null; person?: unknown; error?: string };
    if (!r.ok) throw new Error(got.error || `${m.name} answered ${r.status}.`);
    const cert = await acct.checkAnswer(got.certificate, m, key);
    const site = pageAddress(got.url);
    if (!site) {
      const row = peers().byMachine(m.id);
      if (row) drop(row, `${JSON.stringify(row.name)} has no page now, so this machine sends it nothing`);
      throw Object.assign(new Error(`${m.name} has no page either: run agentbook webui on one of them.`), { final: true });
    }
    const kept = keep(cert, key, site);
    if ("error" in kept) throw Object.assign(new Error(kept.error), { final: true });
    ownerOf(got.person);
  }
  // Another machine's hello, over iroh: a page of yours links here. One with no page isn't taken.
  async function linked(authorization: string | undefined, text: string, irohKey: string): Promise<object | Failed> {
    if (!acct) return { error: "This machine isn't on an agentbook account, so it links to no other machine.", status: 409 };
    const h = await acct.checkHello(authorization, text, irohKey);
    if ("error" in h) {
      if (h.revoked) reconcile();
      return h;
    }
    const site = pageAddress(h.body.url);
    if (!site) return { error: "Neither machine has a page, so they have nothing to send each other: run agentbook webui on one of them.", status: 409 };
    const kept = keep(h.cert, irohKey, site);
    if ("error" in kept) return kept;
    ownerOf(h.body.person);
    const l = acct.login();
    return { certificate: l.certificate, name: l.name, url: null, person: null };
  }

  // ---------- its iroh endpoint ----------
  // What your machines ask of this one over iroh: a hello, or an unlink from a page linked to it.
  const server = http.createServer(async (req, res) => {
    const key = (req.socket as { irohKey?: string }).irohKey;
    const answer = (status: number, body: object) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    const text = async () => {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > 64 * 1024) throw new Error("too big");
        chunks.push(c);
      }
      return Buffer.concat(chunks).toString("utf8");
    };
    try {
      const path = new URL(req.url || "/", "http://x").pathname;
      if (req.method === "POST" && path === LINK_PATH) {
        const r = await linked(req.headers.authorization, await text(), key);
        if ("error" in r) log(`mesh: link refused (${r.status}: ${r.error})`);
        return "error" in r ? answer(r.status, { error: r.error }) : answer(200, r);
      }
      if (req.method === "POST" && path === UNLINK_PATH) {
        const row = key ? peers().byKey(key) : null;
        if (!row) return answer(403, { error: "Only a machine linked to this one unlinks itself from it." });
        answer(200, {});
        drop(row, `${JSON.stringify(row.name)} unlinked this machine, so this one unlinked it too`);
        if (await acct?.renew()) reconcile();
        return;
      }
      answer(404, { error: "This machine has no page of its own: its threads are on your pages." });
    } catch (e) {
      answer(400, { error: e.message });
    }
  });
  const serve = (s: IrohSocket) => server.emit("connection", s);

  async function onAccount(tries = 1, { again = false } = {}) {
    if (!acct) return;
    if (await acct.renew()) {
      const others = acct.machines().filter((m) => m.id !== acct!.login().machine && !m.revoked).length;
      if (tries > 1 || again) log(`mesh: on your agentbook account as ${JSON.stringify(acct.login().name)}, with no page here; ${others} other machine${others === 1 ? "" : "s"} on it`);
    } else if (!acct.off() && tries < LINK_TRIES) {
      setTimeout(() => void onAccount(tries + 1, { again }), RETRY_MS * 2 ** (tries - 1)).unref();
    }
    reconcile({ again });
  }

  return {
    // On iroh, then a fresh certificate and the account's machines, and a hello to each; again every day.
    async start() {
      if (started || !login) return;
      started = true;
      acct = createAccountList({ home, login, log, unlinked: unlinkedHere });
      irohServe(serve);
      iroh = await startIroh({ key: login.key, admit: acct.admit, log, relay: login.relay });
      if (!iroh) log(`mesh: this machine links to none of your pages: ${irohWhy() || "iroh isn't up here"}`);
      else meshChanged.emit("changed");
      const again = () =>
        setTimeout(() => {
          again();
          void onAccount();
        }, RENEW_MS).unref();
      again();
      // A page that refuses this machine dropped it, or lost it: the relay says which (main.ts says when).
      meshChanged.on("refused", (r: { name: string; key: string }) => {
        const row = peers().get(r.name);
        if (!row || row.key !== r.key || !acct) return;
        log(`mesh: ${JSON.stringify(r.name)}'s page doesn't take this machine: asking the relay whether it's still yours`);
        void acct.machinesNow().then((now) => {
          if (!now) return;
          reconcile();
          const m = now.find((x) => x.id === row.machine && !x.revoked);
          if (m?.key) void linkTo(m, m.key);
        });
      });
      await onAccount(1, { again: true });
    },
    // The pages it's linked to, and the account's machines it isn't linked to and why, for agentbook status.
    list: () => ({
      pages: peers()
        .list()
        .map((r) => ({ name: r.name, site: r.site, path: r.key && iroh ? iroh.path(r.key) : null })),
      not_linked: acct
        ? acct
            .machines()
            .filter((m) => m.id !== acct!.login().machine && !m.revoked && !peers().byMachine(m.id))
            .map((m) => ({ name: m.name, why: why.get(m.id) || (linking.has(m.id) ? "Linking now." : "Not linked yet.") }))
        : [],
      why: login ? (iroh ? null : irohWhy() || "iroh isn't up here") : "This machine isn't on an agentbook account: agentbook login.",
    }),
  };
}
export type CliMesh = ReturnType<typeof createCliMesh>;
