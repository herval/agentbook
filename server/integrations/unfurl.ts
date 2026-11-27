// A web address an agent wrote, as a card: the page's title, its description, its
// site and its picture (og:image), read from the head of the page once and kept a while. Only an address the
// thread's own words have (the routes check, as for its pictures), only from the public internet (web-pictures.ts
// fetchPage), and its picture comes through the server's picture proxy, so the site never sees who's looking.

import { fetchPage } from "./web-pictures.ts";
import type { FetchedPage } from "./web-pictures.ts";

const KEEP_MS = 6 * 3600e3; // a card is read again after this
const FAILED_MS = 30 * 60e3; // one that couldn't be read, tried again after this
const MAX = 800; // cards kept

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", nbsp: " " };
const decode = (s: unknown) =>
  String(s || "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e: string) => (e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e.toLowerCase()] ?? m)))
    .replace(/\s+/g, " ")
    .trim();
const attrs = (tag: string) => {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g)) out[m[1].toLowerCase()] = m[3] ?? m[4] ?? m[5] ?? "";
  return out;
};

// What a page's head says of it: { title, text, site, image } (image an absolute https address), any of them null.
export interface Head {
  title: string | null;
  text: string | null;
  site: string | null;
  image: string | null;
}
export function parseHead(html: string | null | undefined, url: string): Head {
  const head = String(html || "").split(/<\/head>/i)[0].slice(0, 512 * 1024);
  const meta: Record<string, string> = {};
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    const k = (a.property || a.name || "").toLowerCase();
    if (k && a.content != null && !(k in meta)) meta[k] = decode(a.content);
  }
  const title = meta["og:title"] || meta["twitter:title"] || decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1]) || null;
  const text = meta["og:description"] || meta["twitter:description"] || meta.description || null;
  let image = meta["og:image:secure_url"] || meta["og:image"] || meta["twitter:image"] || meta["twitter:image:src"] || null;
  try {
    image = image ? new URL(image, url).href : null;
  } catch {
    image = null;
  }
  const host = (() => {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  })();
  const cut = (s: string | null, n: number) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s || null);
  return { title: cut(title, 200), text: cut(text, 300), site: cut(meta["og:site_name"] || host, 60), image: image && /^https?:\/\//.test(image) ? image.slice(0, 2000) : null };
}

// A link's card: its address, and what its page's head says.
export interface Card extends Head {
  url: string;
}
export function createUnfurl({ hosts = [], fetch = fetchPage }: { hosts?: string[]; fetch?: (url: string, hosts: Set<string>) => Promise<FetchedPage> } = {}) {
  const trusted = new Set(hosts.map((h) => String(h).trim().toLowerCase()).filter(Boolean));
  const kept = new Map<string, { at: number; card?: Card; error?: unknown }>(); // url -> { at, card } or { at, error }
  const going = new Map<string, Promise<Card>>();
  // `url`'s card: { url, title, text, site, image }. Throws, saying why, when the page can't be read.
  async function card(url: string): Promise<Card> {
    const was = kept.get(url);
    if (was && Date.now() - was.at < (was.error ? FAILED_MS : KEEP_MS)) {
      if (was.error) throw was.error;
      return was.card;
    }
    if (!going.has(url)) {
      going.set(
        url,
        fetch(url, trusted)
          .then((p): Card => ({ url, ...parseHead(p.html, p.url) }))
          .then(
            (c) => (kept.set(url, { at: Date.now(), card: c }), c),
            (e) => {
              kept.set(url, { at: Date.now(), error: e });
              throw e;
            },
          )
          .finally(() => {
            going.delete(url);
            while (kept.size > MAX) kept.delete(kept.keys().next().value);
          }),
      );
    }
    return going.get(url);
  }
  return { card };
}
