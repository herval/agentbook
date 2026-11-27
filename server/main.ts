#!/usr/bin/env node
// agentbook-server: the page, people's accounts, and everything of everyone's machines.
// It keeps what each machine's agentbook-cli sends (server/relay.ts) and decides per viewer what they see
// (policy.ts). It runs nothing it's given: what happens on a machine is a command to that machine's CLI, which
// checks it first. Zero dependencies. Run: bin/agentbook-server   (its settings: config.ts)
//
// It serves the page, and the CLIs that log in to it with their device tokens. It has no machine of its own, and
// trusts nothing for coming from loopback: agentbook-cli serves a machine's sessions, on that machine.
//
// This file is the server itself: who may use what, its WebSockets, and listening. What the areas share is in
// server/core/: what the server keeps, a request and its answer, threads and agents wherever they are, follows, commands
// to machines, and what runs on its own. Each area's routes, with what only that area uses, are a file in server/api/.

import http from "node:http";
import { accept as acceptWs, refuse as refuseUpgrade } from "./ws.ts";
import { HOST, PORT, PREVIEW_URL, PUBLIC_URL, SERVER_HOME } from "./config.ts";
import { PROTOCOL } from "../plugin/shared/protocol.ts";
import { irohServe } from "../plugin/shared/iroh.ts";
import { EMBEDDED, accounts, log, relay, state, whenRelay } from "./core/state.ts";
import { PREVIEW_HOST, PUBLIC_ORIGIN, fail, ok, route, routes } from "./core/http.ts";
import type { Req } from "./core/http.ts";
import { contactsFromFollows } from "./core/follows.ts";
import { cloud, dashboards, live, news, pushLive, search } from "./core/services.ts";
import { liveHeard } from "./api/views.ts";
import { machineOf } from "./api/cli.ts";
import { cookieToken } from "./api/people.ts";
import { setupHeard } from "./api/cloud-machines.ts";
import { pictureSent } from "./api/queries.ts";
import { terminals } from "./api/terminals.ts";
import { archiveHear, offHear } from "./api/archive.ts";
import { onPreviewName } from "./api/files.ts";
import { noteSharesMemo, pageSharesMemo } from "./api/tasks.ts";
import { routines, unremoveRoutines } from "./api/routines.ts";
import { blobOk, groupsHear } from "./api/groups.ts";
import { shipHear } from "./api/task-ship.ts";
import { serveStatic } from "./api/static.ts";
import { learnRelayApp } from "./integrations/github-app.ts";
import { learnRelayLinear } from "./integrations/linear-app.ts";
import "./api/prs.ts";
import "./api/passkeys.ts";
import "./api/machines.ts";
import "./api/images.ts";
import "./api/threads.ts";
import "./api/agents.ts";
import "./api/contacts.ts";
import "./api/feed.ts";
import "./api/workspaces.ts";
import "./api/pages.ts";
import "./api/notes.ts";
import "./api/guests.ts";
import "./api/search.ts";
import "./api/thread-search.ts";
import "./api/talks.ts";
import "./api/connectors.ts";
import "./api/github.ts";
import "./api/linear.ts";
import "./api/launch.ts";
import "./api/mesh.ts";
import { door } from "./api/door.ts";
import { feedSoon, wirePeopleThings } from "./api/people-things.ts";
import { wirePeopleComments } from "./api/people-comments.ts";
import { wirePeopleSpaces } from "./api/people-spaces.ts";
import "./api/signin.ts";
import "./api/test-people.ts";
import "./api/upgrades.ts";
export { logInMachine } from "./api/people.ts";

// What goes between you and people elsewhere, once every module is loaded.
wirePeopleThings();
wirePeopleComments();
wirePeopleSpaces();
export { meshPeers, setMachine, unlinkMesh } from "./api/mesh.ts";

// What a machine's changes set going, everywhere: its machine's data (core/state.ts's relay) only calls these.
whenRelay({
  onPicture: (D, op) => pictureSent(D, op),
  blobOk: (D, sha) => blobOk(D, sha),
  onHeld: (D) => cloud?.held(D),
  onChange: (D, op, { steps = false, info = null } = {}) => {
    cloud?.heard(D);
    // What people elsewhere see may have changed with it (./api/people-things.ts).
    feedSoon();
    // A machine in a cloud sandbox turned busy or idle, or its agentbook-cli started: its auto-stop follows.
    if (info?.includes("pace")) {
      cloud?.pace(D).catch(() => {});
      setupHeard(D);
    }
    if (String(op?.t || "").startsWith("launch.")) {
      pageSharesMemo.clear();
      noteSharesMemo.clear();
    }
    liveHeard(D, op, info);
    search.hearDevice(D, op);
    pushLive({ steps, all: false });
    groupsHear(D, op);
    shipHear(D, op);
    archiveHear(D, op, info);
    offHear(D, op);
    news?.hear(D, op);
  },
});

// For anyone: that it's up, not how busy everyone's machines are.
route("GET", "/api/health", (req, res) => ok(res, { ok: true, name: "agentbook", server: true, protocol: PROTOCOL }));
// The WebSockets: a page's live events (live.ts), a page's for one of its person's terminals (its sign-in, from
// agentbook's own page), and a machine's line, for all of its own terminals (its device token).
function upgraded(req: Req, socket, head, url) {
  if (url.pathname === "/api/live/ws") {
    if (!ownOrigin(req)) return refuseUpgrade(socket, 403, "agentbook only takes this from its own page.");
    const ws = acceptWs(req, socket, head);
    if (!ws) return;
    req.user = accounts.sessionUser(cookieToken(req));
    if (!req.user) return ws.close(4401, "Sign in first.");
    return live.socket(req, ws, { id: url.searchParams.get("live"), last: url.searchParams.get("last") });
  }
  if (url.pathname === "/api/cli/terminals/ws") {
    const D = machineOf(req);
    if (!D) return refuseUpgrade(socket, 403, "This machine isn't logged in to this agentbook-server.");
    const ws = acceptWs(req, socket, head);
    return ws && terminals.machine(D.id, ws);
  }
  const m = /^\/api\/terminals\/([^/]+)\/ws$/.exec(url.pathname);
  if (!m) return refuseUpgrade(socket, 404, "No such endpoint");
  if (!ownOrigin(req)) return refuseUpgrade(socket, 403, "agentbook only takes this from its own page.");
  const ws = acceptWs(req, socket, head);
  if (!ws) return;
  const user = accounts.sessionUser(cookieToken(req));
  if (!user) return ws.close(4401, "Sign in first.");
  const T = terminals.of(decodeURIComponent(m[1]));
  if (!T || T.uid !== user.id || relay.devices.get(T.device)?.user_id !== user.id) return ws.close(4404, "No such terminal");
  terminals.page(T, ws, req, url.searchParams.get("from"));
}

/* ---------- server ---------- */

// Who may use what:
// - machines logged in to this server: /api/cli, with their device token;
// - anyone: the page itself, and signing in, signing up, and asking to log a machine in;
// - everything else: someone signed in.
// And whatever posts must come from agentbook's own page: another site can't post as you. Nothing is trusted for
// coming from loopback.
// A peek link carries its own key (and a sandboxed frame couldn't send the cookie anyway).
const openRoute = (req: Req, url: URL) => url.pathname.startsWith("/api/auth/") || (req.method === "POST" && url.pathname === "/api/devices/start") || (req.method === "GET" && (url.pathname === "/api/devices/poll" || url.pathname === "/api/cli/bundle" || url.pathname === "/api/cli/git" || url.pathname === "/api/health" || url.pathname.startsWith("/api/peek/") || (onPreviewName(req) && url.pathname.startsWith("/api/files/"))));
// From agentbook's own page: its name as the request has it, or the address people reach it at (AGENTBOOK_SERVER_URL),
// for a proxy in front that sends its own name as Host. A browser always says where a WebSocket is from.
function ownOrigin(req: Req) {
  try {
    const o = new URL(req.headers.origin || "");
    return o.host === req.headers.host || o.origin === PUBLIC_ORIGIN;
  } catch {
    return false;
  }
}
function sameSite(req: Req) {
  if (req.method === "GET" || req.method === "HEAD") return true;
  const origin = req.headers.origin;
  if (origin && origin !== "null") {
    try {
      // Its own name, as the request has it, or the address people reach it at (AGENTBOOK_SERVER_URL), for a proxy
      // in front that sends its own name as Host.
      const o = new URL(origin);
      if (o.host !== req.headers.host && o.origin !== PUBLIC_ORIGIN) return false;
    } catch {
      return false;
    }
  } else if (origin === "null") return false;
  const site = req.headers["sec-fetch-site"];
  return !site || site === "same-origin" || site === "none";
}

// Who's asking, or why not: null to go ahead, or an HTTP status and message.
function admit(req: Req, url: URL): [number, string] | null {
  if (!url.pathname.startsWith("/api/")) return null;
  if (url.pathname.startsWith("/api/cli/")) return null; // the route checks the device token
  if (!sameSite(req)) return [403, "agentbook only takes changes from its own page."];
  if (openRoute(req, url)) return null;
  req.user = accounts.sessionUser(cookieToken(req));
  return req.user ? null : [401, "Sign in first."];
}

// A stray throw off the request path (a timer, a live-stream write, a bad record in one machine's data) must never
// take the whole server down for everyone: log it and keep running. The request path has its own try/catch below.
// Embedded, the process's own (plugin/cli/crash.ts) does that for both halves.
if (!EMBEDDED) {
  process.on("uncaughtException", (err) => log(`uncaught: ${err?.stack || err}`));
  process.on("unhandledRejection", (err) => log(`unhandled rejection: ${(typeof err === "object" && err && "stack" in err && err.stack) || err}`));
}
const previewServes = (req: Req, url: URL) => req.method === "GET" && (url.pathname.startsWith("/api/peek/") || url.pathname === "/api/health" || (/^\/api\/files\/[^/]+$/.test(url.pathname) && url.searchParams.has("t")));
const GITHUB_BACK = /^\/api\/github\/app\/(installed|created)$/;
// A call from another machine of yours over iroh (../plugin/shared/iroh.ts): what one page asks of another, and
// nothing else (the page and its sign-in are for browsers).
const overIroh = (req: Req) => !!(req.socket as { irohKey?: string }).irohKey;
const server = http.createServer(async (req: Req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (overIroh(req) && !url.pathname.startsWith("/api/cli/")) return fail(res, 404, "No such endpoint");
  // GitHub sends people back to where the hub's GitHub App was made. An app made while the page was still at what
  // is now the previews' name comes back there: pass it on to the page's name, where they're signed in.
  if (PREVIEW_HOST && req.headers.host === PREVIEW_HOST && req.method === "GET" && GITHUB_BACK.test(url.pathname) && PUBLIC_ORIGIN !== new URL(PREVIEW_URL).origin) {
    res.writeHead(302, { location: `${PUBLIC_ORIGIN}${url.pathname}${url.search}`, "cache-control": "no-store" });
    return res.end();
  }
  if (PREVIEW_HOST && (req.headers.host === PREVIEW_HOST ? !previewServes(req, url) : url.pathname.startsWith("/api/peek/"))) return fail(res, 404, "No such endpoint");
  const refused = admit(req, url);
  if (refused) return fail(res, refused[0], refused[1], refused[0] === 401 ? { code: "signin" } : {});
  try {
    if (!url.pathname.startsWith("/api/")) return serveStatic(req, res, url.pathname);
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.re);
      if (!m) continue;
      // Ids can hold characters a path escapes (an OpenClaw session key is "agent:main:main").
      const params = Object.fromEntries(Object.entries(m.groups || {}).map(([k, v]) => [k, (() => { try { return decodeURIComponent(v); } catch { return v; } })()]));
      return await r.handler(req, res, { params, query: url.searchParams });
    }
    fail(res, 404, "No such endpoint");
  } catch (err) {
    if (!res.headersSent) fail(res, 400, err.message);
  }
});

// WebSockets: the page's live events, and the terminals' (previews' own name serves none).
server.on("upgrade", (req: Req, socket, head) => {
  const url = new URL(req.url, "http://localhost");
  if ((PREVIEW_HOST && req.headers.host === PREVIEW_HOST) || overIroh(req)) return refuseUpgrade(socket, 404, "No such endpoint");
  try {
    upgraded(req, socket, head, url);
  } catch (err) {
    log(`websocket ${url.pathname}: ${err.stack || err}`);
    socket.destroy();
  }
});

// Node's default of 5 s closes an idle connection while a request sent on it waits unread, if the server stalls in a
// handler past it (a Mac under load), and the machine's push gets ECONNRESET. A minute is longer than any stall we've seen.
server.keepAliveTimeout = 65e3;
// Each stream another machine of yours opens over iroh is a connection to this server, with that machine's key on it.
irohServe((s) => server.emit("connection", s));

// It listens, then starts what runs on its own (routines, contacts from follows, dashboards). On its own (bin/agentbook-server) that's
// at once; embedded, when agentbook calls this, and a port that's taken is the caller's to handle (-> the http server).
export function listen() {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, HOST, () => {
      server.off("error", reject);
      server.on("error", (err) => log(`agentbook-server: ${err?.stack || err}`));
      console.log(`agentbook-server is running at ${PUBLIC_URL}  (data in ${SERVER_HOME})`);
      try {
        unremoveRoutines();
      } catch (e) {
        log(`unremoveRoutines: ${e.message}`);
      }
      routines.start();
      contactsFromFollows();
      try {
        dashboards.tidyAll(state.pages);
      } catch (e) {
        log(`dashboards.tidyAll: ${e.message}`);
      }
      search.start();
      learnRelayApp().catch((e) => log(`learnRelayApp: ${e.message}`));
      learnRelayLinear().catch((e) => log(`learnRelayLinear: ${e.message}`));
      // Your door, on the machine whose page runs it (./door.ts).
      door.start().catch((e) => log(`door: ${e.message}`));
      resolve(server);
    });
  });
}

if (!EMBEDDED) {
  listen().catch((err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`agentbook-server: port ${PORT} is already in use. Is it already running? Try ${PUBLIC_URL}`);
      process.exit(0);
    }
    console.error(`agentbook-server: ${err?.stack || err}`);
    process.exit(1);
  });
}
