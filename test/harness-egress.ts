// What agentbook-server may reach, in tests: only this machine, where its
// integrations' fakes run (GitHub, Linear, web pictures). Node's permission model doesn't cover the network, so
// harness-front.ts loads this into the server (`--import`): a connection anywhere else fails, and says so on the
// server's output ("EGRESS BLOCKED"), where harness-front.ts looks for it. In production, the container's egress
// rules hold the same line.

import dns from "node:dns";
import net from "node:net";

const LOOPBACK = new net.BlockList();
LOOPBACK.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK.addAddress("::1", "ipv6");
const bare = (host: string | undefined) => String(host || "").replace(/^\[|\]$/g, "").replace(/^::ffff:(?=\d)/, "");
const local = (address: string) => {
  const a = bare(address);
  const v = net.isIP(a);
  return !!v && LOOPBACK.check(a, v === 6 ? "ipv6" : "ipv4");
};
const blocked = (what: string) => process.stderr.write(`EGRESS BLOCKED: agentbook-server tried to reach ${what}\n`);

// A lookup that answers only with this machine's addresses (the caller's own lookup, if it brought one, first).
// What a lookup calls back with (only the error, when it fails).
type Done = (err: NodeJS.ErrnoException | null, address?: string | dns.LookupAddress[], family?: number) => void;
const guarded = (inner: net.LookupFunction) => (host: string, opts: dns.LookupOptions | Done, cb?: Done) => {
  if (typeof opts === "function") [cb, opts] = [opts, {}];
  inner(host, opts, (err, address, family) => {
    if (err) return cb(err);
    const list = Array.isArray(address) ? address : [{ address, family }];
    const away = list.find((a) => !local(a.address));
    if (away) {
      blocked(`${host} (${away.address})`);
      return cb(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host} (tests keep the server on this machine)`), { code: "ENOTFOUND" }));
    }
    cb(null, address, family);
  });
};

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
  // The options as given (net.connect hands them over in an array of its own), checked in place.
  const o = (Array.isArray(args[0]) ? args[0][0] : args[0] && typeof args[0] === "object" ? args[0] : null) as (net.TcpSocketConnectOpts & { path?: string }) | null;
  if (o && !o.path && o.host) {
    if (net.isIP(bare(o.host))) {
      if (!local(o.host)) {
        blocked(`${o.host}:${o.port}`);
        process.nextTick(() => this.destroy(Object.assign(new Error(`connect ECONNREFUSED ${o.host}:${o.port} (tests keep the server on this machine)`), { code: "ECONNREFUSED" })));
        return this;
      }
    } else o.lookup = guarded(o.lookup || dns.lookup);
  }
  return connect.apply(this, args);
};
