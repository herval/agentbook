// Pictures from elsewhere on the web, in a post or a page (an agent's `![](https://…)`, an option's image).
// The page never loads one from where it's kept, which would then see the address of everyone who looks: it
// asks the agentbook that has the post or page, which fetches the picture the first time it's wanted, keeps it
// with that post or page in the files folder, and serves that copy from then on. So the site sees this machine,
// once, and the picture stays even when the site loses it.
//
// Not an open proxy: agentbook fetches only an address the post's or page's own words have (`names`, in
// plugin/shared/pictures.ts), only from the public internet (never this machine, its network, or a cloud's metadata
// address, however its name resolves), only a picture, and at most 10 MB of one. `hosts` (AGENTBOOK_PICTURE_HOSTS)
// are exceptions: a picture server on this network, "nas.local" or "192.168.1.20:8080", that pictures may come from
// anyway.
//
// A picture its agent names by its path on its machine (`![](/tmp/shot.png)`, a screenshot it took) is kept
// the same way, from the copy its machine sends up (`load`) instead of fetched: as soon as its agent names it,
// since that's often a folder that's emptied soon after, and again whenever it names it again. Another machine of
// yours linked to this page sends none up, so it's asked for its copy the first time the picture's wanted.

import crypto from "node:crypto";
import dns from "node:dns";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { imageType } from "../avatars.ts";

const MAX = 10 * 1048576;
const HOPS = 5; // redirects followed
const TIMEOUT_MS = 30e3;
const RETRY_MS = 10 * 60e3; // a picture that couldn't be fetched is tried again after this

// Addresses that aren't the public internet. An IPv4 address written as IPv6 (::ffff:10.0.0.1) counts as itself.
const PRIVATE = new net.BlockList();
const V4: [string, number][] = [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]];
for (const [a, n] of V4) PRIVATE.addSubnet(a, n, "ipv4");
// 64:ff9b::/96 (NAT64) and 2002::/16 (6to4) embed an IPv4 address, so on a host that routes them they'd reach
// loopback, the metadata address or a private range; block them with the rest.
const V6: [string, number][] = [["::", 128], ["::1", 128], ["64:ff9b::", 96], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8], ["2001:db8::", 32]];
for (const [a, n] of V6) PRIVATE.addSubnet(a, n, "ipv6");
export const isPublic = (address: string) => !!net.isIP(address) && !PRIVATE.check(address, net.isIP(address) === 6 ? "ipv6" : "ipv4");

// A name resolves to its public addresses only, and the connection goes to the address checked here, so a name
// that answers differently the second time (DNS rebinding) can't lead anywhere else.
function lookup(host: string, opts: dns.LookupOptions, cb: (err: NodeJS.ErrnoException | null, address?: string | dns.LookupAddress[], family?: number) => void) {
  dns.lookup(host, { all: true, family: opts?.family || 0 }, (err, list) => {
    if (err) return cb(err);
    const ok = list.filter((a) => isPublic(a.address));
    if (!ok.length) return cb(Object.assign(new Error(`${host} isn't on the public internet.`), { code: "ENOTPUBLIC" }));
    if (opts?.all) cb(null, ok);
    else cb(null, ok[0].address, ok[0].family);
  });
}

// An error that says its HTTP status, and one from a request (its `code`), or one of these.
type Failure = Error & { status: number };
type RequestError = NodeJS.ErrnoException & { status?: number };
const failure = (status: number, message: string): Failure => Object.assign(new Error(message), { status });

// A picture's bytes, and what they are.
export interface Picture {
  type: string;
  buf: Buffer;
}
// GET a picture: { type, buf }. Throws, saying why, for anything else.
function download(url: string, hosts: Set<string>, hops = 0): Promise<Picture> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return Promise.reject(failure(400, "That isn't a web address."));
  }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) return Promise.reject(failure(400, "Only a picture on the web, at an http or https address."));
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const trusted = hosts.has(u.host) || hosts.has(u.hostname);
  if (net.isIP(host) && !isPublic(host) && !trusted) return Promise.reject(failure(403, `${host} isn't on the public internet.`));
  return new Promise((resolve, reject) => {
    const req = (u.protocol === "https:" ? https : http).get(u, { ...(trusted ? {} : { lookup }), agent: false, headers: { "user-agent": "agentbook", accept: "image/*" } }, (res) => {
      const done = (e: Error) => {
        res.destroy();
        reject(e);
      };
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (hops >= HOPS) return reject(failure(502, `${u.host} sent it on too many times.`));
        let next: string;
        try {
          next = new URL(res.headers.location, u).href;
        } catch {
          return reject(failure(502, `${u.host} sent it on to something that isn't an address.`));
        }
        return download(next, hosts, hops + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) return done(failure(res.statusCode === 404 || res.statusCode === 410 ? 404 : 502, `${u.host} answered ${res.statusCode}.`));
      const said = String(res.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
      if (!/^image\/[\w.+-]+$/.test(said)) return done(failure(415, `That's not a picture: ${u.host} says it's ${said || "something unnamed"}.`));
      if (Number(res.headers["content-length"]) > MAX) return done(failure(413, "That picture is over 10 MB."));
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX) done(failure(413, "That picture is over 10 MB."));
        else chunks.push(c);
      });
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        resolve({ type: imageType(buf) || said, buf });
      });
      res.on("error", reject);
    });
    const timer = setTimeout(() => req.destroy(failure(504, `${u.host} took too long.`)), TIMEOUT_MS);
    req.on("close", () => clearTimeout(timer));
    req.on("error", (e: RequestError) => reject(e.status ? e : e.code === "ENOTPUBLIC" ? failure(403, e.message) : failure(502, `Couldn't reach ${u.host}: ${e.message}`)));
  });
}

// GET a web page's head, for its link card (unfurl.ts): { url (where it ended up), html (its first 512 KB) }. From
// the public internet only, as a picture is.
const PAGE_MAX = 512 * 1024;
export interface FetchedPage {
  url: string;
  html: string;
}
export function fetchPage(url: string, hosts: Set<string> = new Set(), hops = 0): Promise<FetchedPage> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return Promise.reject(failure(400, "That isn't a web address."));
  }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) return Promise.reject(failure(400, "Only a page on the web, at an http or https address."));
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const trusted = hosts.has(u.host) || hosts.has(u.hostname);
  if (net.isIP(host) && !isPublic(host) && !trusted) return Promise.reject(failure(403, `${host} isn't on the public internet.`));
  return new Promise((resolve, reject) => {
    const req = (u.protocol === "https:" ? https : http).get(u, { ...(trusted ? {} : { lookup }), agent: false, headers: { "user-agent": "agentbook (link preview)", accept: "text/html,application/xhtml+xml" } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (hops >= HOPS) return reject(failure(502, `${u.host} sent it on too many times.`));
        let next: string;
        try {
          next = new URL(res.headers.location, u).href;
        } catch {
          return reject(failure(502, `${u.host} sent it on to something that isn't an address.`));
        }
        return fetchPage(next, hosts, hops + 1).then(resolve, reject);
      }
      const said = String(res.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
      if (res.statusCode !== 200 || !/^(text\/html|application\/xhtml\+xml)$/.test(said)) {
        res.destroy();
        return reject(failure(res.statusCode !== 200 ? 502 : 415, res.statusCode !== 200 ? `${u.host} answered ${res.statusCode}.` : `That's not a web page: ${u.host} says it's ${said || "something unnamed"}.`));
      }
      const chunks: Buffer[] = [];
      let size = 0;
      const end = () => resolve({ url: u.href, html: Buffer.concat(chunks).toString("utf8") });
      res.on("data", (c: Buffer) => {
        chunks.push(c);
        size += c.length;
        // Its head is all a card needs.
        if (size >= PAGE_MAX || /<\/head>/i.test(c.toString("latin1"))) {
          res.destroy();
          end();
        }
      });
      res.on("end", end);
      res.on("error", reject);
    });
    const timer = setTimeout(() => req.destroy(failure(504, `${u.host} took too long.`)), 10e3);
    req.on("close", () => clearTimeout(timer));
    req.on("error", (e: RequestError) => reject(e.status ? e : e.code === "ENOTPUBLIC" ? failure(403, e.message) : failure(502, `Couldn't reach ${u.host}: ${e.message}`)));
  });
}

// The pictures kept for posts and pages, in <files>/pictures/<post or page>/: each one's bytes, and what it is
// next to them (<hash>.json: its address, type and size).
// A picture kept: its file, what it is, its size and a name for it.
export interface KeptPicture {
  file: string;
  type: string;
  size: number;
  name: string;
}
export function createWebPictures({ dir, hosts: named = [] }: { dir: string; hosts?: string[] }) {
  const hosts = new Set(named.map((h) => String(h).trim().toLowerCase()).filter(Boolean));
  const fetching = new Map<string, Promise<KeptPicture>>(); // file -> its fetch
  const failed = new Map<string, { at: number; error: unknown }>(); // file -> { at, error }
  const folder = (owner: string) => path.join(dir, String(owner).replace(/[^\w.-]+/g, "_").slice(0, 160));

  // The copy kept of `url` for `owner` ("post-<id>", "page-<id>"), fetched now if there isn't one, or when
  // it's `fresh`: { file, type, size, name }. `load` gets a picture that isn't on the web: () -> { type, buf }.
  async function get(owner: string, url: string, { load = null, fresh = false }: { load?: (() => Picture | Promise<Picture>) | null; fresh?: boolean } = {}): Promise<KeptPicture> {
    const file = path.join(folder(owner), crypto.createHash("sha256").update(url).digest("hex").slice(0, 32));
    const name = path.basename(URL.parse(url)?.pathname || url).replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "picture";
    if (!fresh) {
      try {
        const meta = JSON.parse(fs.readFileSync(`${file}.json`, "utf8")) as { url?: string; type: string; size: number };
        if (meta.url === url && fs.existsSync(file)) return { file, type: meta.type, size: meta.size, name };
      } catch {}
    }
    // A site that failed is left alone a while; a file here is cheap to look for again.
    const was = !load && failed.get(file);
    if (was && Date.now() - was.at < RETRY_MS) throw was.error;
    if (!fetching.has(file)) {
      const got = (load ? Promise.resolve().then(load) : download(url, hosts))
        .then(({ type, buf }) => {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(`${file}.part`, buf);
          fs.renameSync(`${file}.part`, file);
          fs.writeFileSync(`${file}.json`, JSON.stringify({ url, type, size: buf.length, at: new Date().toISOString() }));
          failed.delete(file);
          return { file, type, size: buf.length, name };
        })
        .catch((e) => {
          if (!load) failed.set(file, { at: Date.now(), error: e });
          throw e;
        })
        .finally(() => fetching.delete(file));
      fetching.set(file, got);
    }
    return fetching.get(file);
  }

  return { get };
}
