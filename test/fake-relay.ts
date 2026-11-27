// agentbook-relay, faked for agentbook's tests (../agentbook-relay, its PROTOCOL.md): a page's sign-in, a machine's
// `agentbook login` (the device flow and its certificate), and what a linked machine says to it after. It signs as
// the relay does, with an Ed25519 key it publishes, so the page and the machine check its tokens with the same code
// they use for the real one (plugin/shared/relay-verify.ts). What a person does in a browser on the relay (saying yes
// to a code, signing in) is a call here instead.
//
//   const relay = await fakeRelay();
//   relay.url                                   its address
//   relay.person = { sub, acct, email, name }   who signs in at /login next, and whose account a code joins
//   relay.cancels = true                        the next sign-in says Cancel
//   relay.waiting()                             the code a machine is showing, as its person reads it
//   relay.approve(userCode) / relay.deny(userCode)
//   relay.machines(acct)                        an account's machines, as the relay has them
//   relay.stalls = n                            the next n calls to /machines… never get an answer (a relay that
//                                               woke as they came, and lost them)
//   relay.doorOf(acct)                          an account's door, as the relay has it (PROTOCOL.md, 10)
//   relay.certifyDoor(acct, key)                certifies a door with no machine signing for it (test/door.ts)
//   relay.close()

import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { deviceProofInput, doorProofInput, publicKeyOf, signingInput } from "../plugin/shared/relay-verify.ts";

export interface FakePerson {
  sub: string;
  acct: string;
  email?: string;
  name?: string;
  picture?: string;
}
interface Machine {
  id: string;
  account: string;
  name: string;
  platform: string;
  key: string;
  addresses: string[];
  linked: string;
  seen: string | null;
  revoked: string | null;
  only_here?: Record<string, number>;
}
interface Device {
  user_code: string;
  key: string;
  name: string;
  platform: string;
  page: string | null;
  state: "pending" | "approved" | "denied" | "claimed";
  machine: string | null;
  expires: number;
}

const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
const hash = (s: string) => crypto.createHash("sha256").update(s).digest("base64url");

export async function fakeRelay() {
  const key = crypto.generateKeyPairSync("ed25519");
  const kid = "fake-1";
  const machines = new Map<string, Machine>();
  const devices = new Map<string, Device>(); // by the poll secret's hash
  const doors = new Map<string, { key: string; machine: string }>(); // account → its door
  const relay = {
    url: "",
    person: { sub: "google:1001", acct: crypto.randomUUID(), email: "ada@example.com", name: "Ada Lovelace" } as FakePerson,
    // A page's sign-in: `cancels` to say Cancel there, or claims to change in the token.
    cancels: false,
    tamper: {} as Record<string, unknown>,
    // Every request it took, as "METHOD /path", for tests that count them.
    seen: [] as string[],
    stalls: 0,
    approve(userCode: string, acct = relay.person.acct): string {
      const d = [...devices.values()].find((x) => x.user_code === userCode);
      if (!d || d.state !== "pending") throw new Error(`no code ${userCode} waiting`);
      const same = [...machines.values()].find((m) => m.key === d.key);
      if (same && (same.account !== acct || same.revoked)) throw new Error("that key is another account's, or unlinked");
      const id = same?.id ?? crypto.randomUUID();
      if (!same) machines.set(id, { id, account: acct, name: d.name, platform: d.platform, key: d.key, addresses: [], linked: new Date().toISOString(), seen: null, revoked: null });
      d.state = "approved";
      d.machine = id;
      return id;
    },
    deny(userCode: string) {
      const d = [...devices.values()].find((x) => x.user_code === userCode);
      if (d) d.state = "denied";
    },
    machines: (acct: string) => [...machines.values()].filter((m) => m.account === acct),
    // A door certified as a machine of `acct`'s would have it (POST /doors), for tests of doors alone (test/door.ts).
    certifyDoor(acct: string, key: string) {
      doors.set(acct, { key, machine: "test" });
      return certifyDoor(acct);
    },
    doorOf: (acct: string) => doors.get(acct) ?? null,
    unlink(id: string) {
      const m = machines.get(id);
      if (m && !m.revoked) m.revoked = new Date().toISOString();
    },
    // The code a machine is showing now (the newest pending), as a person would read it off their terminal.
    waiting: () => [...devices.values()].filter((d) => d.state === "pending").at(-1)?.user_code ?? null,
    close: () =>
      new Promise<void>((r) => {
        for (const res of held) res.destroy();
        server.close(() => r());
      }),
  };

  const sign = (claims: object, typ: string) => {
    const signed = `${b64({ alg: "EdDSA", typ, kid })}.${b64(claims)}`;
    return `${signed}.${crypto.sign(null, Buffer.from(signed), key.privateKey).toString("base64url")}`;
  };
  const certify = (m: Machine) => {
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + 7 * 86400;
    return {
      account: m.account,
      machine: m.id,
      name: m.name,
      certificate: sign({ iss: relay.url, sub: m.id, acct: m.account, key: m.key, name: m.name, iat, exp }, "agentbook-machine+jwt"),
      expires_at: new Date(exp * 1000).toISOString(),
      machines: relay.machines(m.account).map(({ only_here, ...rest }) => rest),
    };
  };

  const certifyDoor = (acct: string) => {
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + 7 * 86400;
    const key = doors.get(acct)!.key;
    return { key, certificate: sign({ iss: relay.url, sub: acct, acct, key, iat, exp }, "agentbook-door+jwt"), expires_at: new Date(exp * 1000).toISOString() };
  };

  const held = new Set<http.ServerResponse>();
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url || "/", relay.url);
    relay.seen.push(`${req.method} ${u.pathname}`);
    if (u.pathname.startsWith("/machines") && relay.stalls > 0) {
      relay.stalls--;
      held.add(res);
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString();
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    let body: Record<string, unknown> = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {}

    if (u.pathname === "/.well-known/jwks.json") {
      const { x } = key.publicKey.export({ format: "jwk" });
      return json(200, { keys: [{ kty: "OKP", crv: "Ed25519", x, kid, alg: "EdDSA", use: "sig" }] });
    }
    if (u.pathname === "/login") {
      const origin = u.searchParams.get("origin")!;
      const back = new URL("/api/auth/relay/done", origin);
      back.searchParams.set("state", u.searchParams.get("state")!);
      if (relay.cancels) back.searchParams.set("error", "access_denied");
      else {
        const iat = Math.floor(Date.now() / 1000);
        const claims = { iss: relay.url, aud: origin, nonce: u.searchParams.get("nonce"), iat, exp: iat + 300, jti: crypto.randomUUID(), provider: "google", email_verified: true, ...relay.person, ...relay.tamper };
        back.searchParams.set("token", sign(claims, "JWT"));
      }
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (req.method === "POST" && u.pathname === "/device") {
      if (typeof body.key !== "string" || !publicKeyOf(body.key) || typeof body.name !== "string") return json(400, { error: "invalid_request" });
      const deviceCode = crypto.randomBytes(32).toString("base64url");
      const userCode = Array.from(crypto.randomBytes(8), (b, i) => (i === 4 ? "-" : "") + "BCDFGHJKLMNPQRSTVWXZ"[b % 20]).join("");
      devices.set(hash(deviceCode), { user_code: userCode, key: body.key, name: body.name, platform: String(body.platform ?? "unknown"), page: (body.page as string) ?? null, state: "pending", machine: null, expires: Date.now() + 600e3 });
      return json(200, { device_code: deviceCode, user_code: userCode, verification_uri: `${relay.url}/link`, verification_uri_complete: `${relay.url}/link?code=${userCode}`, expires_in: 600, interval: 1 });
    }
    if (req.method === "POST" && u.pathname === "/device/token") {
      const d = devices.get(hash(String(body.device_code)));
      const k = d ? publicKeyOf(d.key) : null;
      if (!d || !k || !crypto.verify(null, deviceProofInput(String(body.device_code)), k, Buffer.from(String(body.sig), "base64url"))) return json(400, { error: "invalid_grant" });
      if (d.state === "denied") return json(400, { error: "access_denied" });
      if (d.state === "claimed") return json(400, { error: "invalid_grant" });
      if (d.state === "approved") {
        d.state = "claimed";
        return json(200, certify(machines.get(d.machine!)!));
      }
      if (d.expires < Date.now()) return json(400, { error: "expired_token" });
      return json(400, { error: "authorization_pending" });
    }
    // What a linked machine signs.
    const auth = /^Agentbook\s+(.+)$/i.exec(String(req.headers.authorization || ""));
    if (auth) {
      const said = Object.fromEntries([...auth[1].matchAll(/(\w+)=([^,\s]+)/g)].map((m) => [m[1], m[2]]));
      const m = machines.get(said.machine);
      const k = m ? publicKeyOf(m.key) : null;
      if (!m || !k || !crypto.verify(null, signingInput(req.method!, u.pathname + u.search, Number(said.at), text), k, Buffer.from(String(said.sig), "base64url"))) return json(401, { error: "unauthorized" });
      if (m.revoked) return json(403, { error: "unlinked", revoked: m.revoked });
      m.seen = new Date().toISOString();
      if (req.method === "POST" && u.pathname === "/machines/renew") return json(200, certify(m));
      if (req.method === "GET" && u.pathname === "/machines") return json(200, { machines: relay.machines(m.account) });
      if (req.method === "POST" && u.pathname === "/machines/report") {
        Object.assign(m, body);
        res.writeHead(204);
        return res.end();
      }
      if (u.pathname === "/doors" && req.method === "GET") return json(200, { door: doors.has(m.account) ? { key: doors.get(m.account)!.key, machine: doors.get(m.account)!.machine, certified: new Date().toISOString() } : null });
      if (u.pathname === "/doors" && req.method === "POST") {
        const key = String(body.key ?? "");
        const k = publicKeyOf(key);
        if (!k || !crypto.verify(null, doorProofInput(m.account, key), k, Buffer.from(String(body.proof ?? ""), "base64url"))) return json(400, { error: "invalid_grant" });
        if ([...doors].some(([a, d]) => d.key === key && a !== m.account) || [...machines.values()].some((x) => x.key === key)) return json(409, { error: "taken" });
        doors.set(m.account, { key, machine: m.id });
        return json(200, certifyDoor(m.account));
      }
      if (u.pathname === "/doors" && req.method === "DELETE") {
        doors.delete(m.account);
        res.writeHead(204);
        return res.end();
      }
      const one = /^\/machines\/([^/]+)$/.exec(u.pathname);
      if (req.method === "DELETE" && one) {
        const target = machines.get(one[1]);
        if (!target || target.account !== m.account) return json(404, { error: "not_found" });
        relay.unlink(target.id);
        return json(200, { id: target.id, revoked: target.revoked });
      }
    }
    json(404, { error: "not_found" });
  });
  server.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  relay.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return relay;
}
