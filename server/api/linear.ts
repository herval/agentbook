// Signing in with Linear (agentbook's Linear app, linear-app.ts) rather than pasting an API key: the page asks where to
// send the person, Linear sends them back here with a code, and their Linear connector takes the tokens it's traded
// for. What came of it is said once on Connectors (GET /api/linear/note).

import { CALLBACK, begin, exchange, signinReady } from "../integrations/linear-app.ts";
import { fail, ok, readBody, route, str } from "../core/http.ts";
import type { ConnectorSave } from "../integrations/connectors.ts";
import { connectors, pushLive } from "../core/services.ts";
import { connectorInput, connectorsMine } from "./connectors.ts";
import { originOf } from "./github.ts";

const WAIT_MS = 3600e3;
// state -> a sign-in under way, until Linear sends its person back: whose, the connector's settings, and what Linear's
// code is traded with (the PKCE verifier, the app's client ID, the address Linear sent them back to).
const signins = new Map<string, { uid: string; by: string; settings: { id?: string } & ConnectorSave; verifier: string; client_id: string; redirect_uri: string; at: number }>();
const notes = new Map<string, string>(); // uid -> what came of their sign-in

// Start one: its settings are their Linear connector's (what comes into Tasks, and where), for a new one, or `id`
// for one of theirs signing in again. They come back to the address the page is at, by way of the sign-in relay when
// it names agentbook's Linear app (linear-app.ts).
route("POST", "/api/linear/signin", async (req, res) => {
  if (!connectorsMine(req, res)) return;
  const cant = connectors.cantKeep();
  if (cant) return fail(res, 503, cant);
  const b = await readBody<Record<string, unknown>>(req);
  const settings: { id?: string } & ConnectorSave = connectorInput(b);
  delete settings.api_key;
  delete settings.kind;
  if (b.id) settings.id = str(b.id, 100);
  for (const [k, v] of signins) if (v.uid === req.user.id || Date.now() - v.at > WAIT_MS) signins.delete(k);
  await signinReady();
  const s = begin(originOf(req));
  signins.set(s.state, { uid: req.user.id, by: req.user.username, settings, verifier: s.verifier, client_id: s.client_id, redirect_uri: s.redirect_uri, at: Date.now() });
  ok(res, { url: s.url });
});

// Linear sends them back with a code and the state, or with why not: either way, back to Connectors.
route("GET", CALLBACK, async (req, res, { query }) => {
  if (!connectorsMine(req, res)) return;
  const back = (note: string) => {
    notes.set(req.user.id, note);
    res.writeHead(302, { location: "/#/connectors", "cache-control": "no-store" });
    res.end();
  };
  const state = String(query.get("state") || "");
  const s = signins.get(state);
  if (!s || s.uid !== req.user.id || Date.now() - s.at > WAIT_MS) return back("Linear sent you back without a sign-in agentbook started here, so nothing changed. Sign in with Linear again.");
  signins.delete(state);
  const error = query.get("error");
  if (error) return back(error === "access_denied" ? "You didn't let agentbook in on Linear, so nothing changed." : `Linear didn't sign you in: ${str(query.get("error_description") || error, 300)}`);
  try {
    const tokens = await exchange(str(query.get("code"), 500), s);
    const c = await connectors.signedIn(s.uid, s.by, s.settings, tokens, "linear");
    pushLive();
    back(`Signed in with Linear${c.who ? ` as ${c.who}` : ""}. ${s.settings.id ? "" : "Its issues are on their way to your Tasks."}`.trim());
  } catch (e) {
    back(`Linear didn't sign you in: ${e.message}`);
  }
});

route("GET", "/api/linear/note", (req, res) => {
  if (!connectorsMine(req, res)) return;
  const note = notes.get(req.user.id) || null;
  notes.delete(req.user.id);
  ok(res, { note });
});
