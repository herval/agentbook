// agentbook on a machine that isn't on anyone's account yet (plugin/shared/machine-login.ts onNoAccount): what its
// page's port serves, in place of the page. Its one button is `agentbook login` (relay-login.ts), run from the
// browser: the relay's page opens, its person signs in and says yes to the code, and this process gets the machine's
// certificate and makes the account's folder; then `onLinked` hands over to agentbook running in it, which serves the
// real page at the same address. Nothing of the account is written until then, so a machine is never half someone's.
// The machine's own port stays agentbook-cli's (main.ts), which tells its sessions it isn't logged in.

import http from "node:http";
import { relayUrl } from "../shared/machine-login.ts";
import { relayLogin } from "./relay-login.ts";

type Log = (line: string) => void;
interface Waiting {
  url: string;
  code: string;
}

const PAGE = (relayHost: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>agentbook</title>
<style>
  :root { color-scheme: light; font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #1d1d1f; background: #f6f6f4; }
  main { max-width: 380px; margin: 14vh auto 0; padding: 28px; background: #fff; border: 1px solid #e4e4e0; border-radius: 10px; }
  h1 { font-size: 20px; margin: 0 0 6px; }
  p { margin: 8px 0; color: #55554f; }
  button { margin-top: 14px; width: 100%; padding: 10px 14px; font: inherit; font-weight: 600; color: #fff; background: #1d1d1f; border: 0; border-radius: 7px; cursor: pointer; }
  button:disabled { opacity: .6; cursor: default; }
  code { font: 600 17px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .06em; }
  .err { color: #b3261e; }
  .muted { color: #8a8a82; }
</style>
</head>
<body>
<main>
  <h1>agentbook</h1>
  <p id="say">This machine isn't on your agentbook yet. Sign in to add it: its page opens here once you have.</p>
  <button id="go" type="button">Sign in with Google</button>
  <p class="muted"><small>Through ${relayHost}, which keeps your account and your machines, and nothing else.</small></p>
</main>
<script>
const say = document.getElementById("say"), go = document.getElementById("go");
async function look() {
  const s = await fetch("/api/first-run/status").then((r) => r.json()).catch(() => null);
  if (!s) return setTimeout(() => location.reload(), 1500); // handed over: the page is coming up
  if (s.state === "done") return setTimeout(() => location.reload(), 1000);
  if (s.state === "failed") { say.textContent = s.error; say.className = "err"; go.disabled = false; return; }
  if (s.state === "waiting") { say.innerHTML = "Check the relay's page shows <code></code>, and say yes there."; say.querySelector("code").textContent = s.code; }
  setTimeout(look, 1500);
}
go.onclick = async () => {
  go.disabled = true;
  const r = await fetch("/api/first-run/start", { method: "POST" }).then((r) => r.json()).catch(() => ({ error: "agentbook didn't answer. Try again." }));
  if (r.error) { say.textContent = r.error; say.className = "err"; go.disabled = false; return; }
  window.open(r.url, "_blank") || (location.href = r.url);
  look();
};
look();
</script>
</body>
</html>
`;

export function serveFirstRun({ port, host = "127.0.0.1", home, root, log, onLinked }: { port: number; host?: string; home: string; root: string; log: Log; onLinked: (home: string) => void }) {
  let state: "idle" | "starting" | "waiting" | "done" | "failed" = "idle";
  let waiting: Waiting | null = null;
  let pending: Promise<Waiting> | null = null;
  let error = "";
  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  const relayHost = new URL(relayUrl()).host;
  // What the browser asked for began here: its own origin, or none (a form a page elsewhere posts has one).
  const sameOrigin = (req: http.IncomingMessage) => !req.headers.origin || req.headers.origin === `http://${req.headers.host}`;

  // One login at a time: a second click while one waits is the same one.
  function start(): Promise<Waiting> {
    if (pending && (state === "starting" || state === "waiting")) return pending;
    state = "starting";
    error = "";
    return (pending = new Promise((resolve, reject) => {
      relayLogin(["--no-open"], {
        print: () => {},
        home,
        root,
        onCode: (d) => {
          waiting = { url: d.url, code: d.code };
          state = "waiting";
          resolve(waiting);
        },
      }).then(
        (done) => {
          state = "done";
          log(`first run: ${done.login.name} is on its person's account now; agentbook starts again in ${done.home}`);
          // A moment for the page to hear it, then the port goes to agentbook itself.
          setTimeout(() => onLinked(done.home), 1200);
        },
        (e) => {
          state = "failed";
          error = e.message;
          waiting = null;
          log(`first run: ${e.message}`);
          reject(e);
        },
      );
    }));
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://x");
    if (url.pathname === "/api/health") return json(res, 200, { ok: true, name: "agentbook", firstRun: true });
    if (url.pathname === "/api/first-run/status") return json(res, 200, { state, ...(waiting ? { code: waiting.code } : {}), ...(error ? { error } : {}) });
    if (url.pathname === "/api/first-run/start") {
      if (req.method !== "POST" || !sameOrigin(req)) return json(res, 403, { error: "Start from this machine's page." });
      return void start().then(
        (w) => json(res, 200, w),
        (e) => json(res, 502, { error: e.message }),
      );
    }
    if (url.pathname.startsWith("/api/")) return json(res, 503, { error: "This machine isn't on an agentbook account yet: sign in on its page, or run agentbook login." });
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'", "x-frame-options": "DENY" });
    res.end(PAGE(relayHost));
  });
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    listen: () =>
      new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          log(`first run: this machine isn't on an account yet; sign in at ${url}`);
          resolve();
        });
      }),
  };
}
