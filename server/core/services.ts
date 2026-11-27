// What runs on its own, made once as the server starts and in this order, since making one may call the ones before:
// telling open pages what changed (live.ts), connectors, cloud sandboxes, dashboards' queries, image builds, and
// threads' news for the bell.

import path from "node:path";
import { createLive } from "../live.ts";
import { sideOf } from "../side.ts";
import { createConnectors } from "../integrations/connectors.ts";
import { createDashboards } from "../dashboards.ts";
import { createSecrets } from "../secrets.ts";
import * as boat from "../integrations/connectors/boat.ts";
import { MACHINE_KINDS, providerOf } from "../integrations/connectors/machines.ts";
import { createCloud } from "../cloud.ts";
import { createImages } from "../images.ts";
import { createNews } from "../news.ts";
import { createSearch } from "../search.ts";
import { PUBLIC_URL, SERVER_HOME } from "../config.ts";
import { accounts, commit, firstAdmin, log, relay, state, storage, store } from "./state.ts";
import { keptOff, ownerOf } from "./refs.ts";
import { feedSeen, signedInNow, threadSeen, viewOnce } from "../api/views.ts";
import { boxMates, cloudLink, cloudPayer } from "../api/machines.ts";
import { taskId } from "../api/tasks.ts";
import { pageOwner } from "../api/pages.ts";

// Cloud sandboxes (cloud.ts), made further down.
export let cloud = null;
export let imagesOf: typeof images.summary | null = null; // images.summary, once images are made (further down)
export let news: ReturnType<typeof createNews> | null = null; // threads' news for the bell (news.ts), made further down

// What changed goes to the open pages (live.ts) 80 ms later; what's only what threads are doing this moment (a
// step, which machines send all the time while their agents work) at most once a second. `all`: what changed isn't
// a machine's (the relay says which of its things changed: liveHeard), so the pages look again at all they show.
const PUSH_MS = 80;
const STEPS_MS = 1000;
let pushTimer = null;
let pushDue = 0;
let pushedAt = 0;
export function pushLive({ steps = false, all = true } = {}) {
  if (all) live.mark({ all: true });
  const due = Math.max(Date.now() + PUSH_MS, steps ? pushedAt + STEPS_MS : 0);
  if (pushTimer && pushDue <= due) return;
  clearTimeout(pushTimer);
  pushDue = due;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    pushedAt = Date.now();
    // What each person may see, made once however many of their pages look.
    live.flush({ views: new Map() });
  }, due - Date.now());
}
// Full-text search index over server entities and device transcripts (search.db).
export const search = createSearch({ file: path.join(SERVER_HOME, "search.db"), relay, state, log });
// Stopping (a reload on a new commit) flushes it, so starting again doesn't index everything over.
process.once("exit", () => search.close());
store.onChange((op) => {
  search.hearServer(op);
  pushLive();
});

// Each open page's own stream of what changed in what it shows.
export const live = createLive({ threadOf: threadSeen, deviceOf: (id) => relay.resolve(id)?.D.id || null, feedOf: feedSeen, sideOf: (req, ctx) => sideOf(viewOnce(req, ctx)), whoIs: signedInNow });

// Connectors (Linear, …) fill their owner's Tasks. Each is one person's own, with their own API key, and everyone's
// are kept in the database, their keys sealed with AGENTBOOK_SECRET_KEY; see connectors.ts and secrets.ts.
const secrets = createSecrets();
if (secrets.problem) log(secrets.problem);
export const connectors = createConnectors({
  state,
  commit,
  log,
  storage,
  secrets,
  ownerOf: (username) => (username ? accounts.byUsername(username) : firstAdmin()),
  // A workspace of theirs by its id, its name, or its repo ("github.com/herval/agentbook" or "herval/agentbook").
  workspaceOf: (owner, ref) => {
    if (!ref) return null;
    const mine = Object.values(state.workspaces).filter((w) => w.owner === owner);
    const r = String(ref).toLowerCase();
    return (mine.find((w) => w.id === ref) || mine.find((w) => w.name.toLowerCase() === r) || mine.find((w) => w.repo && (w.repo.toLowerCase() === r || w.repo.toLowerCase().endsWith(`/${r}`))))?.id || null;
  },
  taskId: () => taskId(),
  // A machines connector's machines, looked after on its schedule: one deleted there noticed, a boat disk kept past 14 days.
  tend: (c, uid) => cloud?.tend(uid, c.id),
  changed: () => pushLive(),
});
// Machines that run in a cloud sandbox (cloud.ts): the server wakes one, with its owner's boat or exe.dev connector,
// when something waits for it. Which sandbox is a machine's is its owner's to say, on the machine's page
// (machine.cloud), or agentbook made it there.
cloud = createCloud({
  relay,
  providerOf,
  // A member's seat on a shared machine runs in that machine's sandbox, on its owner's account there (boxOf).
  linkOf: (D) => cloudLink(D),
  connOf: (D, id) => connectors.byId(cloudPayer(D)?.id, id, MACHINE_KINDS),
  mates: (D) => boxMates(D),
  // The machines linked to a connector of one person's, when each was last here, and what's found of its sandbox.
  linked: (uid, id) => [...relay.devices.values()].filter((D) => ownerOf(D)?.id === uid && state.machine_cloud?.[D.id]?.connector === id),
  seenOf: (D) => Math.max(D.seen || 0, Date.parse(accounts.deviceById(D.id)?.last_seen || "") || 0),
  found: (D, patch) => commit({ t: "machine.cloud", device: D.id, patch }),
  changed: () => pushLive(),
  log,
});
// What waited across a restart: once, after machines that are on have had time to connect. And each one that's on
// has its sandbox's auto-stop set by whether it's busy, which this server no longer remembers having done.
setTimeout(() => {
  for (const D of relay.devices.values()) {
    if (!state.machine_cloud?.[D.id]) continue;
    if (relay.online(D)) cloud.pace(D).catch(() => {});
    else if (relay.waiting(D).some((c) => Date.parse(c.expires) - Date.now() > 120e3)) cloud.held(D);
  }
}, Number(process.env.AGENTBOOK_CLOUD_BOOT_MS || 30e3)).unref();
// Dashboards' queries (dashboards.ts): each panel asks its dashboard owner's connectors.
export const dashboards = createDashboards({ connectors, storage, log, ownerOf: (p) => pageOwner(p) });
export const images = createImages({
  state,
  commit,
  boat,
  connOf: (uid, id) => connectors.byId(uid, id, "boat"),
  publicUrl: PUBLIC_URL,
  host: new URL(PUBLIC_URL).host.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 60),
  changed: () => pushLive(),
  log,
});
images.resume();
imagesOf = images.summary;
// Threads' news for the bell (news.ts). A turn is news from 10 minutes on.
news = createNews({ commit, ownerOf, idOf: (D, local) => relay.idOf(D, local), hidden: keptOff, newsOf: (uid) => state.news?.[uid] || [], turnMs: Number(process.env.AGENTBOOK_NEWS_TURN_MS || 600e3), waitMs: Number(process.env.AGENTBOOK_NEWS_MS || 3000), log });
