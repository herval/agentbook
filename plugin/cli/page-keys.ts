// Your passkeys on the pages of the machines this one is linked to, for its gate to take what you sign there with no
// Sign once (gate.ts, takeSite): every machine on your account, with a page of its own or not, takes what you sign on
// any page of yours. The page's certificate says the page is yours, and the connection it proved carries the ask.
// It asks as its uplink to that page connects, and as that page asks it to (keys.fetch), the first time only: after
// that, a change of them comes signed by one it keeps.

import { irohNode, irohWhy } from "../shared/iroh.ts";
import { SITE_PATH, type Failed } from "../shared/mesh-link.ts";
import type { PeerRow, PeerTables } from "../shared/storage/peers.ts";

// Your passkeys on a page, as that page says them (server/api/mesh.ts, /api/cli/mesh/site).
export interface PageKeys {
  origin: string;
  rp_id: string;
  keys: { id: string; alg: number; spki: string; name?: string }[];
}
export type From = { peer: string; url: string };

interface Deps {
  peers: () => PeerTables;
  log: (line: string) => void;
  // Whether this machine keeps keys for that page already.
  keeps: (from: From) => boolean;
  // Takes the passkeys a linked page said. -> how many it keeps, or why it took none.
  take: (from: From, site: PageKeys) => Promise<{ keys: number } | { error: string } | null>;
}

export async function readPageKeys(row: PeerRow | null): Promise<PageKeys | Failed> {
  const name = row?.name || "That machine";
  if (!row?.site || !row.key) return { error: `${name} isn't a page linked to this machine.`, status: 404 };
  const iroh = irohNode();
  if (!iroh) return { error: `This machine can't reach ${name}: ${irohWhy() || "iroh isn't up here"}.`, status: 503 };
  let r: Response;
  try {
    r = await iroh.fetch(row.key, SITE_PATH, { signal: AbortSignal.timeout(15e3) });
  } catch (e) {
    return { error: `This machine can't reach ${name} over iroh (${e.cause?.message || e.message}).`, status: 502 };
  }
  const got = (await r.json().catch(() => ({}))) as Partial<PageKeys> & { error?: string };
  if (!r.ok) return { error: got.error || `${name}'s page answered ${r.status}.`, status: 502 };
  if (got.origin !== row.site || typeof got.rp_id !== "string" || !Array.isArray(got.keys)) return { error: `${name}'s page didn't say its passkeys as an agentbook page does.`, status: 502 };
  if (!got.keys.length) return { error: `You have no passkey on ${name}'s page yet: make one there (${row.site}, on your profile).`, status: 409 };
  return { origin: got.origin, rp_id: got.rp_id, keys: got.keys };
}

// -> takeKeys(name): how many it keeps of that page's (-1: none taken now, as it kept some already or the page had
// none to give), or why none.
export function createPageKeys({ peers, log, keeps, take }: Deps) {
  return async function takeKeys(name: string): Promise<{ keys: number } | Failed> {
    const row = peers().get(name);
    if (row?.site && row.key && keeps({ peer: name, url: row.site })) return { keys: -1 };
    const got = await readPageKeys(row);
    if ("error" in got) return got;
    const from = { peer: name, url: got.origin };
    const took = await take(from, { origin: got.origin, rp_id: got.rp_id, keys: got.keys });
    if (took && "error" in took) {
      log(`mesh: ${took.error}`);
      return { error: took.error, status: 409 };
    }
    return took && "keys" in took ? took : { keys: -1 };
  };
}
