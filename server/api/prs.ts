// Pull requests: a workspace's, read from GitHub for whoever may see them, and each thread's, watched for where
// they stand.

import { NO_TOKEN as NO_GITHUB, asWho, carry, githubRepo, listPulls, prChanges, prOfUrl, prUrl, pullNumbers, readLinked } from "../integrations/pulls.ts";
import { appConfig, installations, linksOf } from "../integrations/github-app.ts";
import type { Device } from "../relay.ts";
import type { Session, Workspace } from "../../plugin/shared/types.ts";
import { log, relay, state } from "../core/state.ts";
import { allPosts, ownerOf } from "../core/refs.ts";
import { connectors, live, pushLive } from "../core/services.ts";
import { shipPrChanged, shipPrDue, ships } from "./task-ship.ts";


// How agentbook reads GitHub for a person: as them, with the token of their GitHub connector (Connectors), and
// nothing else. Nobody reads GitHub as anyone else: someone without one has no pull requests here until they
// connect GitHub. { token, who } or null, `who` naming whose reads they are, to keep them apart.
export function ghFor(uid: string) {
  if (!uid) return null;
  const token = connectors.keyFor(uid, "github");
  return token ? { token, who: asWho(token) } : null;
}
// Why a repo GitHub won't show someone is out of sight, when it's agentbook's GitHub App's doing: they signed in
// with it, and it isn't installed on the repo's owner, or it is but only for repos picked for it, and this one
// wasn't. -> { text, label, url, account } (url: where on GitHub to fix it), or null: they connected a token
// instead, or the app reads every repo of that owner (so their own account can't see it, or it isn't there).
// Where the app is installed is asked once a minute at most, per sign-in.
const appInstalls = new Map(); // who -> { at, list }
async function seeWhy(uid: string, repo, token) {
  const r = githubRepo(repo);
  if (!r || !token || connectors.keyFor(uid, "github", "app") !== token) return null;
  const who = asWho(token);
  let c = appInstalls.get(who);
  if (!c || Date.now() - c.at > 60e3) {
    const list = await installations(token).catch(() => null);
    if (!list) return null;
    for (const [k, v] of appInstalls) if (Date.now() - v.at > 600e3) appInstalls.delete(k);
    appInstalls.set(who, (c = { at: Date.now(), list }));
  }
  const i = c.list.find((x) => x.account?.toLowerCase() === r.owner.toLowerCase());
  if (i?.all) return null;
  if (!i) return { account: r.owner, text: `agentbook's GitHub App isn't installed on ${r.owner}, so it can't read ${r.slug}.`, label: `Install it on ${r.owner}`, url: linksOf(appConfig()).install };
  return { account: i.account, text: `agentbook's GitHub App reads only the ${i.account} repos picked for it, and ${r.name} isn't one.`, label: `Add ${r.name} on GitHub`, url: i.url };
}
// A workspace's pull requests, for its WIP (see pulls.ts): read from GitHub as its person (ghFor), in the
// background, again every 90 seconds, every 20 while one of them is open on a page, and right away when a post of
// theirs links one it didn't have, or one of their machines has a branch it didn't. Each person's reads are their
// own: GitHub says what they may see.
const PULLS_MS = 90e3;
const PULLS_OPEN_MS = 20e3;
export const pullsCache = new Map(); // "who|repo" -> { at, key, data, reading, looked }
export const pullsKey = (repo, gh) => `${gh.who}|${repo}`;
// The branches a person's machines have of a repo with work on them, as they report their WIP: each one's pull
// request is read too.
function localHeads(repo: string, uid: string) {
  const out = new Set<string>();
  for (const D of relay.devices.values()) {
    if (ownerOf(D)?.id !== uid) continue;
    for (const f of relay.infoOf(D).folders?.folders || []) if (f.remote === repo) for (const w of f.wip || []) out.add(w.branch);
  }
  return [...out].sort();
}
export function pullsOf(repo, uid: string, fresh = false) {
  const gh = ghFor(uid);
  if (!gh) return { login: null, pulls: [], error: NO_GITHUB };
  const extra = pullNumbers(repo, prLinks(uid));
  const heads = localHeads(repo, uid);
  const key = `${[...extra].sort((a, b) => a - b).join(",")}|${heads.join(",")}`;
  const ck = pullsKey(repo, gh);
  const c = pullsCache.get(ck) || { at: 0, key: null, data: undefined, reading: false, looked: 0 };
  pullsCache.set(ck, c);
  const every = Date.now() - c.looked < 120e3 ? PULLS_OPEN_MS : PULLS_MS;
  if ((fresh || c.key !== key || Date.now() - c.at > every) && !c.reading) {
    c.reading = true;
    listPulls(repo, { extra, heads, host: "agentbook", token: gh.token })
      .then(
        (d) => ({ ...d, error: null, fix: null }),
        async (e) => {
          // GitHub doesn't show the repo: say whether agentbook's GitHub App is why, and where to fix it.
          const why = e.code === "unseen" ? await seeWhy(uid, repo, gh.token).catch(() => null) : null;
          return { login: c.data?.login || null, pulls: c.data?.pulls || [], heads: c.data?.heads || [], error: why?.text || e.message, fix: why };
        },
      )
      .then((data) => {
        const changed = JSON.stringify(data) !== JSON.stringify(c.data);
        Object.assign(c, { at: Date.now(), key, data, reading: false });
        if (changed) pushLive();
      });
  }
  return c.data;
}
// The pull requests a person's own posts linked (not the ones they unlinked), on every machine of theirs.
export const linkedUrls = (s: Session) => Object.values(s.prs || {}).filter((p) => p.url && !p.off).map((p) => p.url);
function prLinks(uid: string) {
  const urls = [];
  // By the machine's own field, not ownerOf: this walks every post, per workspace, for every open page on every push.
  for (const p of allPosts()) if (uid && p.D.user_id === uid) urls.push(...linkedUrls(p.s));
  return urls;
}
// While a page is open, workspaces on GitHub keep reading it even when nothing else changes.
setInterval(() => {
  if (!live.open) return;
  const seen = new Set();
  for (const w of Object.values(state.workspaces)) {
    if (!githubRepo(w.repo) || seen.has(`${w.owner}|${w.repo}`)) continue;
    seen.add(`${w.owner}|${w.repo}`);
    if (ghFor(w.owner)) pullsOf(w.repo, w.owner);
  }
}, 10e3).unref();
// A workspace as its person sees it: a repo on GitHub, once they've connected GitHub, carries its pull requests,
// theirs: the ones their GitHub account opened, the ones their own posts linked, and their branches' (`pulls`
// null: not read yet). Its WIP is its branches, each one with a pull request shown as that.
export function workspaceView(w: Workspace, sessions): Omit<Workspace, "wip"> & { pulls?: ReturnType<typeof pullsOf> | null } {
  const { wip: _, ...view } = w;
  if (!githubRepo(w.repo) || !ghFor(w.owner)) return view;
  const data = pullsOf(w.repo, w.owner);
  if (!data) return { ...view, pulls: null };
  const linked = new Set(pullNumbers(w.repo, sessions.filter((s) => s.mine).flatMap(linkedUrls)));
  const heads = new Set(data.heads || []);
  return { ...view, pulls: { ...data, pulls: data.pulls.filter((p) => p.author === data.login || linked.has(p.number) || heads.has(p.number)) } };
}

/* ---------- a post's pull requests, where they stand ---------- */

// Every pull request a post links, read from GitHub as the post's person (with their GitHub connector), whether or
// not a page is open: an open one every 90 seconds, every 20 while a page shows its post, every 10 minutes once its
// post is a month old; a merged one not again, a closed one for a day. A post on a branch with no pull request of
// its own on it looks for one every 5 minutes, while it's going or ended in the last week.
// What a read finds goes on every post that links the pull request, with a line on each when it's news.
export const PR_MS = Number(process.env.AGENTBOOK_PR_MS || 90e3);
const PR_LOOKED_MS = Math.min(PR_MS, 20e3);
export const PR_OLD_MS = Math.max(PR_MS, 600e3);
const PR_HEAD_MS = Number(process.env.AGENTBOOK_PR_HEAD_MS || 300e3);
export const prLooked = new Map(); // post id -> when a page last showed it
export const prReads = new Map(); // "owner/name#12", lowercase -> when it was last read
const headReads = new Map(); // "post|branch" -> when GitHub was last asked for that branch's pull request
const prBusy = new Set(); // repos being read now
const prErrors = new Map(); // repo -> why it couldn't be read last time, said once in the log
const prWho = new Map(); // person -> whose GitHub connection their posts' pull requests are read with, to notice it change
export const NOT_HEADS = new Set(["HEAD", "main", "master", "develop", "trunk"]);
// The repo on GitHub a post's folder is a checkout of ("github.com/owner/name"), as its machine reports its
// folders, or null.
function repoOfPost(D: Device, s) {
  const f = s?.root && (relay.infoOf(D).folders?.folders || []).find((x) => x.root === s.root);
  return f?.remote && githubRepo(f.remote) ? f.remote : null;
}
export const prKey = (uid: string, slug, n) => `${uid}|${`${slug}#${n}`.toLowerCase()}`;
// Whether one of a post's pull requests is due to be read again, for its person (`uid`).
function prDue(uid: string, s, id: string, p, now) {
  const g = p.gh;
  const last = prReads.get(prKey(uid, p.repo, p.number)) || 0;
  if (!g) return now - last > Math.min(PR_MS, 30e3); // not read yet (or GitHub didn't have it): soon
  if (g.state === "merged") return false;
  if (g.state === "closed") return now - Date.parse(g.closed || 0) < 86400e3 && now - last > PR_OLD_MS;
  const every = now - (prLooked.get(id) || 0) < 120e3 ? PR_LOOKED_MS : now - Date.parse(s.started) > 30 * 86400e3 ? PR_OLD_MS : PR_MS;
  return now - last > every;
}
export function watchPrs() {
  const now = Date.now();
  const byOwner = new Map(); // uid -> Map("github.com/owner/name" -> { numbers, heads: branch -> [post refs] })
  for (const p of allPosts()) {
    const uid = ownerOf(p.D)?.id;
    const gh = ghFor(uid);
    if (!gh) continue;
    // Connecting GitHub (or signing in again) reads what couldn't be read without it now, not in 10 minutes.
    if (prWho.get(uid) !== gh.who) {
      prWho.set(uid, gh.who);
      for (const k of [...prReads.keys()]) if (k.startsWith(`${uid}|`)) prReads.delete(k);
    }
    const due = byOwner.get(uid) || byOwner.set(uid, new Map()).get(uid);
    const of = (repo) => due.get(repo) || due.set(repo, { numbers: new Set(), heads: new Map() }).get(repo);
    const s = p.s;
    for (const pr of Object.values(s.prs || {})) {
      if (!pr.url || !pr.repo || pr.off) continue;
      // Not a link to a pull request (an older CLI read `-R $R` as a repo called "$R"): nothing to read, a dead link
      // on the thread, and the page can't unlink it, because its route takes real links only.
      if (!prOfUrl(pr.url)) p.D.store.commit({ t: "session.pr", post: p.local, url: pr.url, off: true });
      else if (prDue(uid, s, p.id, pr, now)) of(`github.com/${pr.repo}`).numbers.add(pr.number);
    }
    const b = s.branch;
    if (!b || NOT_HEADS.has(b) || s.cloud || s.archived) continue;
    if (s.state === "done" && now - Date.parse(s.ended || s.updated) > 7 * 86400e3) continue;
    if (Object.values(s.prs || {}).some((x) => x.gh?.head === b)) continue; // it has its branch's (or you unlinked it)
    if (now - (headReads.get(`${p.id}|${b}`) || 0) < PR_HEAD_MS) continue;
    const repo = repoOfPost(p.D, s);
    if (!repo) continue;
    headReads.set(`${p.id}|${b}`, now);
    const heads = of(repo).heads;
    (heads.get(b) || heads.set(b, []).get(b)).push(p);
  }
  // A pull request put in a task is read for it too, whether or not a thread of theirs links it (task-ship.ts).
  for (const t of Object.values(state.tasks)) {
    if (!t.ship?.items?.length || !ships(t) || !ghFor(t.owner)) continue;
    const due = byOwner.get(t.owner) || byOwner.set(t.owner, new Map()).get(t.owner);
    for (const x of t.ship.items) {
      const pr = x.kind === "pr" && prOfUrl(x.url);
      if (!pr || !shipPrDue(t, x.url, pr, now)) continue;
      const repo = `github.com/${pr.repo}`;
      (due.get(repo) || due.set(repo, { numbers: new Set(), heads: new Map() }).get(repo)).numbers.add(pr.number);
    }
  }
  for (const [uid, due] of byOwner) {
    const gh = ghFor(uid);
    for (const [repo, want] of due) {
      const key = `${uid}|${repo}`;
      // One that can't be read mustn't throw: this is a timer, and every repo after it would go unread, every time.
      const slug = githubRepo(repo)?.slug;
      if (!slug || prBusy.has(key)) continue;
      const numbers = [...want.numbers].slice(0, 45);
      for (const n of numbers) prReads.set(prKey(uid, slug, n), now);
      prBusy.add(key);
      // One GitHub doesn't have (or a repo it can't see, or GitHub failing) is asked again in 10 minutes, not soon.
      const later = () => now + PR_OLD_MS - PR_MS;
      readLinked(repo, { numbers, heads: [...want.heads.keys()].slice(0, 30) }, { host: "agentbook", token: gh.token })
        .then((r) => {
          prErrors.delete(key);
          for (const n of numbers) if (!r.pulls[n]) prReads.set(prKey(uid, slug, n), later());
          prsRead(uid, slug, r, want.heads);
        })
        .catch((e) => {
          if (prErrors.get(key) !== e.message) log(`pull requests in ${slug}: ${e.message}`);
          prErrors.set(key, e.message);
          if (e.code !== "no-github") for (const n of numbers) prReads.set(prKey(uid, slug, n), later());
        })
        .finally(() => prBusy.delete(key));
    }
  }
}
// What a read found: each pull request's new state on the posts of its person that link it, and a branch's pull
// request linked to the posts on that branch, when it was going while they were (not an old one that happened to
// use the name).
function prsRead(uid: string, slug, r, heads) {
  for (const [n, card] of Object.entries(r.pulls)) if (card) prChanged(uid, prUrl(slug, n), card);
  for (const [branch, posts] of heads) {
    for (const p of posts) {
      const s = p.D.store.state.sessions[p.local];
      const pr = s && (r.heads[branch] || []).find((c) => c.head !== r.base && c.updated >= s.started && (!c.closed || c.closed >= s.started));
      if (!pr || Object.keys(s.prs || {}).some((u) => u.toLowerCase() === pr.url.toLowerCase())) continue;
      p.D.store.commit({ t: "session.pr", post: p.local, url: pr.url, number: pr.number, repo: slug, how: "branch", at: new Date().toISOString(), gh: carry(null, pr) });
    }
  }
}
function prChanged(uid: string, url, card) {
  const u = url.toLowerCase();
  for (const p of allPosts()) {
    if (ownerOf(p.D)?.id !== uid) continue;
    const [key, pr] = Object.entries(p.s.prs || {}).find(([k]) => k.toLowerCase() === u) || [];
    if (!pr || pr.off) continue;
    const next = carry(pr.gh, card);
    if (pr.gh && JSON.stringify(next) === JSON.stringify(pr.gh)) continue;
    p.D.store.commit({ t: "session.pr", post: p.local, url: key, gh: next });
    for (const l of prChanges(pr.gh, next)) p.D.store.commit({ t: "session.update", post: p.local, text: l.text, pr: { url: key, number: next.number, kind: l.kind } });
  }
  shipPrChanged(uid, url, card);
}
setTimeout(watchPrs, 3000).unref();
setInterval(watchPrs, Number(process.env.AGENTBOOK_PR_TICK_MS || 10e3)).unref();
