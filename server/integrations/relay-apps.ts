// What the sign-in relay names for pages with no app of their own, in its /.well-known/agentbook-relay
// (agentbook-relay's PROTOCOL.md): agentbook's GitHub App (github-app.ts) and its Linear app (linear-app.ts). Asked for
// as the server starts and when someone signs in with none, at most once a minute, so both read the one answer.
// null when there's no relay or it can't be reached: then what each kept from before stands.

import { SIGNIN_RELAY } from "../config.ts";

type Named = Record<string, unknown>;
const asked = new Map<string, { at: number; said: Promise<Named | null> }>();

export function relayNames(relay = SIGNIN_RELAY): Promise<Named | null> {
  if (!relay) return Promise.resolve(null);
  const last = asked.get(relay);
  if (last && Date.now() - last.at < 60e3) return last.said;
  const said = (async () => {
    try {
      const r = await fetch(`${relay}/.well-known/agentbook-relay`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10e3) });
      if (!r.ok) return null;
      const doc = await r.json();
      return doc && typeof doc === "object" && !Array.isArray(doc) ? (doc as Named) : null;
    } catch {
      return null;
    }
  })();
  asked.set(relay, { at: Date.now(), said });
  return said;
}
