#!/usr/bin/env node
// agentbook-cli: this machine's half of agentbook. Its daemon serves this machine's
// sessions on loopback (hooks, the MCP bridge, /api/mcp), and talks to the agentbook-server it's logged in to over
// HTTPS, with its device token. The page is the server's: / here sends you there. Not logged in yet, it does nothing
// but wait for a login: it follows no session, reads no agent's files, and starts and changes none of them.
// Logged in to this machine's own page, or started with --webui (`agentbook webui`), the daemon serves that page too,
// from this process (webui.ts). On your agentbook account with neither (`agentbook login` alone), it serves no page:
// it links to your pages over iroh by itself, sends them its threads and takes their commands (mesh.ts).
// Run: bin/agentbook-cli [run [--webui]]  the daemon (AGENTBOOK_PORT, AGENTBOOK_HOME; the hooks start it)
//      bin/agentbook-cli <command>        login, logout, status, up, down, help, the gate's, webui (commands.ts)

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PORT, VERSION, seatsIn } from "../lib/common.ts";
import { machineName } from "../shared/ids.ts";
import { CLI_HOME, FILES_DIR, HOME } from "../shared/store.ts";
import { keepPrivate, moveIntoCli } from "./cli-folder.ts";
import { COMMANDS, FLAGS, plainOk, runCommand, save as saveLink } from "./commands.ts";
import { ENROLL_FILE, enroll } from "./enroll.ts";
import { stayUp } from "./crash.ts";
import { createCli } from "./daemon.ts";
import { reloadsFrom, startAgain, watchCheckout } from "./reload.ts";
import { serveFirstRun } from "./first-run.ts";
import { ROOT, machineLogin, onNoAccount } from "../shared/machine-login.ts";
import { createCliMesh, type CliMesh } from "./mesh.ts";
import { createPageKeys } from "./page-keys.ts";
import { watchInstall } from "./uninstall.ts";
import { createUplink, epochOf, httpTransport, irohTransport } from "./uplink.ts";
import { irohNode } from "../shared/iroh.ts";
import type { Uplink } from "./uplink.ts";
import { meshChanged, PeerTables } from "../shared/storage/peers.ts";
import { canHost, createPage, isLocal, pageUrl } from "./webui.ts";
import { BUNDLED } from "../shared/bundle.ts";

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// The server this machine is logged in to, and its device token: AGENTBOOK_SERVER and AGENTBOOK_SERVER_TOKEN,
// else what `agentbook-cli login` saved (cli/device.json), else what `agentbook connect` saved before the split
// (hub.json). Null when it isn't logged in anywhere.
export function serverLink(home = HOME) {
  const url = process.env.AGENTBOOK_SERVER || process.env.AGENTBOOK_HUB;
  if (url) return { url, token: process.env.AGENTBOOK_SERVER_TOKEN || process.env.AGENTBOOK_HUB_TOKEN || "", name: null };
  for (const file of [path.join(home, "cli", "device.json"), path.join(home, "hub.json")]) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      const u = saved.server || saved.url;
      if (u && saved.token) return { url: u, token: saved.token, name: saved.name || null, local: !!saved.local };
    } catch {}
  }
  return null;
}

// The daemon. Not logged in, it looks for a login every few seconds (AGENTBOOK_LINK_POLL_MS), and connects then.
// However a server was given (agentbook-cli login, AGENTBOOK_SERVER, an old hub.json), one elsewhere gets this
// machine's token over HTTPS only, or on a tailnet.
function usable(l) {
  let u = null;
  try {
    u = new URL(l.url);
  } catch {}
  if (u && (u.protocol === "https:" || (u.protocol === "http:" && plainOk(u)))) return true;
  log(`not connecting to ${l.url}: a machine sends its token to a server elsewhere over HTTPS only, or on a tailnet (AGENTBOOK_ALLOW_HTTP=1 allows it anyway)`);
  return false;
}

// The plugin folder its sessions load, in dev mode, when it's started without being told (by a hook, after a
// reboot): the one `agentbook up` was given (cli/settings.json), if it's still there.
function savedPluginDir() {
  if (process.env.AGENTBOOK_PLUGIN_DIR) return;
  try {
    const dir = JSON.parse(fs.readFileSync(path.join(HOME, "cli", "settings.json"), "utf8")).plugin_dir;
    if (dir && fs.existsSync(path.join(dir, ".claude-plugin", "plugin.json"))) process.env.AGENTBOOK_PLUGIN_DIR = dir;
  } catch {}
}

// `webui`: it serves this machine's page too (webui.ts), and logs this machine in to it once it has an account.
export async function runCli({ port = PORT, host = "127.0.0.1", linkPollMs = Number(process.env.AGENTBOOK_LINK_POLL_MS || 3000), webui = false } = {}) {
  // On a shared machine, everyone's agentbook-cli runs as them (seats.ts). One running as root would run agents as root.
  if (process.platform === "linux" && process.getuid() === 0 && seatsIn()) throw new Error("This is a shared machine, where each person's agentbook-cli runs as them, never as root: agentbook-cli seat lists them.");
  const faults = stayUp({ log });
  // A machine agentbook-server made logs itself in from the file it was started with (enroll.ts), before anything
  // else: it then starts as any machine that's logged in does. Before the port, so nothing's served meanwhile.
  await enroll({ home: HOME, linked: !!serverLink(), plainOk, save: saveLink, log }).catch((e) => log(`enroll: ${e.message}`));
  let link = null;
  let cli = null;
  // Its page, when it serves one: started to (webui), or logged in to this machine's own (agentbook up, from before).
  let page = null;
  // With no page and no server, on your account: how it links to your pages (mesh.ts).
  let mesh: CliMesh | null = null;
  // Your passkeys on each page it's linked to, for its gate to take what you sign there (page-keys.ts).
  let takeKeys: ReturnType<typeof createPageKeys> | null = null;
  let firstRun: ReturnType<typeof serveFirstRun> | null = null;
  async function keepPage(l) {
    if (!canHost() || !(webui || isLocal(l))) return;
    page ??= createPage({ url: isLocal(l) ? l.url : pageUrl(), grace: !webui, log });
    await page.keep();
  }
  function connect(l) {
    if (!usable(l)) return false;
    link = l;
    keepPage(l).catch((e) => faults.report(e, "its page"));
    const transport = httpTransport({ url: l.url, token: l.token });
    // The server says whether anyone has the page open, with each answer to the long-poll.
    const uplink = createUplink({ store: cli.store, transport, info: cli.info, onCommand: cli.onCommand, onFresh: cli.fresh, historyFrom: cli.historyFrom, version: VERSION, onOwner: cli.setOwner, onPrefs: cli.setPrefs, onLatest: cli.setLatest, onConnect: cli.connected, clean: cli.clean, epoch: epochOf(cli.store), log });
    cli.setUplink(uplink, l.url);
    uplink.start();
    return true;
  }

  // Your other machines (server/mesh.ts): this machine's threads go to the page of each one it's linked to too,
  // without their work, which that page asks this machine for. What it asks is checked as from elsewhere (gate.ts), by
  // its page's address (`site`) or its name. Over iroh, while this process has iroh up (../shared/iroh.ts), with no
  // token: the connection is this machine. A machine with no page (`site` null) gets nothing.
  // With no page of its own (mesh), the first of them is also where its sessions' agentbook tools ask what only a
  // page knows (tasks, pages, the feed), and says whose machine this is.
  const peers = new Map<string, { site: string; key: string; uplink: Uplink }>();
  let main: Uplink | null = null;
  const REFUSED_MS = Number(process.env.AGENTBOOK_PEER_REFUSED_MS || 30e3);
  function keepPeers() {
    if (!cli) return;
    let want: { name: string; site: string; key: string }[];
    let linked: string[];
    const node = irohNode();
    try {
      const rows = cli.store.storage.use(PeerTables).list();
      linked = rows.map((r) => r.name);
      want = node ? rows.filter((r) => r.key && r.site).map((r) => ({ name: r.name, site: r.site, key: r.key })) : [];
    } catch (e) {
      return log(`couldn't read the machines this one is linked to: ${e.message}`);
    }
    for (const [name, p] of peers) {
      if (want.some((w) => w.name === name && w.site === p.site && w.key === p.key)) {
        // Linked again with nothing new to send by (the same key): one more try, if its page refused it.
        if (p.uplink.status().signed_out) void p.uplink.tryAgain();
        continue;
      }
      p.uplink.stop();
      peers.delete(name);
      // Unlinked, not linked again: this machine takes nothing more signed on its page.
      if (!linked.includes(name)) cli.unlinked({ peer: name, url: p.site }).catch((e) => log(`couldn't stop taking what's signed on ${name}'s page: ${e.message}`));
    }
    // One unlinked: the log keeps nothing more for it.
    for (const name of Object.keys(cli.store.held())) if (!linked.includes(name)) cli.store.hold(name, null);
    for (const w of want) {
      if (peers.has(w.name)) continue;
      // Its page refusing this machine, and still a while later with nothing new meanwhile: it unlinked this machine,
      // or lost it, while this one couldn't be told; the page asks the relay which, and links again to one still on the
      // account (server/mesh.ts).
      const onSignedOut = () => setTimeout(() => peers.get(w.name)?.key === w.key && peers.get(w.name).uplink.status().signed_out && meshChanged.emit("refused", { name: w.name, key: w.key }), REFUSED_MS).unref();
      const transport = irohTransport({ node, key: w.key, name: w.name });
      const keys = () => void takeKeys?.(w.name);
      const own = mesh ? { onOwner: (u) => uplink === main && cli.setOwner(u), onPrefs: (p) => uplink === main && cli.setPrefs(p), onConnect: () => (keys(), uplink === main && cli.connected()) } : { onConnect: keys };
      const uplink = createUplink({ store: cli.store, transport, info: cli.info, onSignedOut, onCommand: (c) => cli.onCommand(c, { peer: w.name, url: w.site }), historyFrom: cli.historyFrom, version: VERSION, clean: cli.clean, epoch: epochOf(cli.store), peer: w.name, ...own, log: (line) => log(`${w.name}: ${line}`) });
      peers.set(w.name, { ...w, uplink });
      uplink.start();
      log(`sending this machine's threads to ${w.name} ${mesh ? "" : "too, "}over iroh`);
    }
    if (mesh) {
      const [name, first] = [...peers.entries()][0] || [];
      if (first?.uplink !== main) {
        main = first?.uplink || null;
        cli.setUplink(main, first?.site || null);
        if (first) log(`its sessions ask ${name}'s page what only a page knows (tasks, pages, the feed)`);
      }
    }
  }
  meshChanged.on("changed", () => keepPeers());

  const server = http.createServer(async (req, res) => {
    // An unsigned startup response looks like an impostor to local clients; a closed connection is retryable.
    if (!cli) return res.destroy();
    const url = new URL(req.url, "http://localhost");
    if (await cli.handle(req, res, url)) return;
    // The page is the server's (this process's own, when it serves it).
    const at = link?.url || page?.hosting() || firstRun?.url;
    if (req.method === "GET" && !url.pathname.startsWith("/api/") && at) {
      res.writeHead(302, { location: at.replace(/\/$/, "") + "/" });
      return res.end();
    }
    const error = link ? `This is agentbook-cli, for this machine's sessions. agentbook is at ${link.url}.` : mesh ? "This is agentbook-cli, for this machine's sessions. This machine has no page of its own: its threads are on your other machines' pages (agentbook webui serves one here too)." : "This is agentbook-cli, for this machine's sessions. It isn't logged in to an agentbook-server yet: run agentbook-cli login <server>, or agentbook webui.";
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error }));
  });
  // DeepSeek Harness's plugin connects here (cli.upgrade); nothing else upgrades.
  server.on("upgrade", (req, socket, head) => {
    if (!cli) return socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nRetry-After: 1\r\nContent-Length: 0\r\n\r\n");
    cli.upgrade(req, socket, head);
  });
  // The port first: several sessions can start this at once, and only the one that gets it goes on to touch its data.
  // Requests arriving while its page starts are refused so reconnecting clients can retry.
  await new Promise<void>((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        console.error(`agentbook-cli: port ${port} is already in use. Is it already running?`);
        process.exit(0);
      }
      reject(err);
    });
    server.listen(port, host, resolve);
  });
  server.on("error", (e) => faults.report(e, "the local server"));
  // Its files from the top of agentbook's folder, into its own, before it opens its database.
  moveIntoCli({ home: HOME, filesDir: FILES_DIR, log });
  savedPluginDir();
  link = serverLink();
  if (link && !usable(link)) link = null;
  // On nobody's account yet (machine-login.ts), its page is the first run's (first-run.ts), whose one button signs in
  // and puts this machine on its person's account; then agentbook starts again in that account's folder. Without the
  // page, it runs logged in to nothing, and tells its sessions how to sign in.
  if (webui && !link && onNoAccount(HOME, ROOT)) firstRun = serveFirstRun({ port: Number(new URL(pageUrl()).port), host, home: HOME, root: ROOT, log, onLinked: (home) => startAgain({ env: { AGENTBOOK_HOME: home }, log: path.join(home, "cli", "cli.log") }) });
  if (webui && link && !isLocal(link)) throw new Error(`this machine is logged in to ${link.url}, where its page is. To serve its page here instead: agentbook cli logout, then agentbook webui.`);
  if (webui && !firstRun && !canHost()) throw new Error("this agentbook-cli has no page to serve: there's no agentbook-server next to it, nor where agentbook webui ran last.");
  // Its page first, so the server it reports to is there when it connects.
  if (firstRun) await firstRun.listen();
  else await keepPage(link);
  const machine = machineName(link?.name || process.env.AGENTBOOK_MACHINE || os.hostname().split(".")[0]);
  const noPage = (why: string) => Promise.reject(Object.assign(new Error(why), { status: 409 }));
  cli = createCli({ machine, faults, page: () => page?.hosting() || firstRun?.url || null, unlink: (name) => (page ? page.unlink(name) : noPage("This machine doesn't serve its own page: unlink it from one of your pages, in Machines, or agentbook unlink there.")), takeKeys: (name) => takeKeys!(name), pages: () => mesh?.list() ?? null });
  takeKeys = createPageKeys({ peers: () => cli.store.storage.use(PeerTables), log, keeps: (from) => cli.keepsSite(from), take: (from, site) => cli.takeSite(from, site) });
  page?.setMachine(machine);
  // On your account, with no page here and no server elsewhere: it links to your pages by itself.
  if (!link && !page && !firstRun && machineLogin(HOME)) mesh = createCliMesh({ home: HOME, peers: () => cli.store.storage.use(PeerTables), machine, log, owner: (u) => cli.setOwner(u) });
  // Its folder only its person reads, its database (just opened, maybe just made) included.
  keepPrivate({ home: HOME, filesDir: FILES_DIR, log });
  console.log(`agentbook-cli is running at http://${host}:${port} as ${machine}, ${link ? `logged in to ${link.url}` : mesh ? "with no page here: it sends its threads to your pages" : "not logged in to a server yet"}  (data in ${CLI_HOME})`);
  // Its plugin uninstalled: nothing would start it again, so nothing should keep it going.
  watchInstall({
    log,
    onGone() {
      log("its Claude Code plugin was uninstalled: stopping");
      process.kill(process.pid, "SIGTERM");
    },
  });
  // Its server first, so what starts knows where it reports to. Serving its own page with no login yet, it logs in
  // to it once its person is there (now, or at their first sign-in), and the look below connects.
  if (link) connect(link);
  else if (page?.hosting()) page.logIn(machine, saveLink);
  if (link || mesh || process.env.AGENTBOOK_START_UNLINKED) cli.start(); // that variable: the tests', which log in as they go
  cli.setPeers(() => [...peers.values()].map((p) => p.uplink));
  keepPeers();
  mesh?.start().catch((e) => faults.report(e, "linking to your pages"));
  // Run from a checkout of agentbook, it starts itself again once a commit there changes its code (reload.ts).
  const repo = reloadsFrom();
  if (repo) watchCheckout({ repo, busy: cli.busy, log });
  if (!link && !mesh) {
    let enrolling = false;
    const look = setInterval(() => {
      const l = serverLink();
      // A machine agentbook-server made, whose login file was written after this started: it logs in with it now, and
      // starts again as that machine (what keeps it running, systemd there, brings it back).
      if (!l && !enrolling && fs.existsSync(ENROLL_FILE())) {
        enrolling = true;
        enroll({ home: HOME, plainOk, save: saveLink, log })
          .then((saved) => {
            if (saved && process.env.AGENTBOOK_SUPERVISED === "1") process.kill(process.pid, "SIGTERM");
          })
          .catch((e) => log(`enroll: ${e.message}`))
          .finally(() => (enrolling = false));
      }
      if (!l) return;
      clearInterval(look);
      if (!connect(l)) return;
      cli.start();
      log(`logged in to ${l.url}`);
    }, linkPollMs);
  }
  return { cli, server };
}

// What `node plugin/cli/main.mjs …` does (the launcher, which checks Node first), and `node plugin/cli/main.ts …`.
export function main(args = process.argv.slice(2)) {
  const [first, ...rest] = args;
  const cmd = FLAGS[first] || first;
  // The daemon leaves the folder it was started in, which is whatever session started it: a worktree, often, and
  // one removed later left it in a folder that's gone, where no `claude` command starts ("The current directory no
  // longer exists"), so no thread started, stopped or was listed until it was restarted. Home is always there.
  // Not with a data folder named from where it stands, which it has yet to open.
  if ((!cmd || cmd === "run") && path.isAbsolute(HOME)) {
    try {
      process.chdir(os.homedir());
    } catch {}
  }
  const run = !cmd || cmd === "run" ? runCli({ webui: rest.includes("--webui") }) : COMMANDS.includes(cmd) ? runCommand([cmd, ...rest]).then((out) => out && console.log(out)) : Promise.reject(new Error(`there's no ${cmd} command. It has: run, ${COMMANDS.join(", ")}.`));
  run.catch((e) => {
    // The daemon's goes to cli.log, for whoever finds out why it didn't start.
    console.error(`agentbook-cli: ${!cmd || cmd === "run" ? e.stack : e.message}`);
    process.exit(1);
  });
}

// In the bundle, plugin/main.ts starts it (import.meta.url is the bundle there, and so is the file run).
if (!BUNDLED && process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) main();
