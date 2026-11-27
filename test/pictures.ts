#!/usr/bin/env node
// Pictures from elsewhere on the web, in posts and pages: they come through agentbook, which keeps a copy with
// the post or page, fetches only what its words name, only from the public internet, only pictures, and shows
// each only to who may see where it is. And pictures on this machine its agent names by their paths, kept the
// same way. Run: node test/pictures.ts

import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnAgentbook, testPort } from "./harness.ts";
import type { Json } from "./harness-types.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "plugin");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-pictures-"));
const PORT = testPort(4700);
const HUB_PORT = PORT + 100;
const URL = `http://127.0.0.1:${PORT}`;
const HUB = `http://127.0.0.1:${HUB_PORT}`;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

let failures = 0;
const check = (cond: unknown, label: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Where the pictures are: a site on this machine, which agentbook is told to trust (AGENTBOOK_PICTURE_HOSTS),
// and which counts what it's asked for.
const asked: Record<string, number> = {};
const site = http.createServer((req, res) => {
  const p = req.url.split("?")[0];
  asked[p] = (asked[p] || 0) + 1;
  if (["/cat.png", "/result.png", "/note.png", "/option.png", "/in-file.png", "/human.png", "/hub.png", "/private.png", "/before.png", "/og.png"].includes(p)) return res.writeHead(200, { "content-type": "image/png" }).end(PNG);
  if (p === "/article.html") return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<html><head><title>Ignored</title><meta property="og:title" content="Release 2.4 &amp; notes"><meta property="og:description" content="What changed"><meta property="og:site_name" content="Acme"><meta property="og:image" content="/og.png"></head><body>…</body></html>`);
  if (p === "/moved.png") return res.writeHead(302, { location: "/cat.png" }).end();
  if (p === "/away.png") return res.writeHead(302, { location: `http://127.0.0.1:${away}/cat.png` }).end();
  if (p === "/page.html") return res.writeHead(200, { "content-type": "text/html" }).end("<script>alert(1)</script>");
  if (p === "/big.png") return res.writeHead(200, { "content-type": "image/png" }).end(Buffer.alloc(11 * 1048576));
  res.writeHead(404).end();
});
await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
const SITE = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
const away = (site.address() as AddressInfo).port + 1; // the same machine, but not the trusted site

const env = { ...process.env, AGENTBOOK_HOME: HOME, AGENTBOOK_PORT: String(PORT), AGENTBOOK_CODEX: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_TERMINAL: "0", AGENTBOOK_CLAUDE: "/usr/bin/false", AGENTBOOK_PICTURE_HOSTS: `127.0.0.1:${(site.address() as AddressInfo).port}` };
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_URL", "AGENTBOOK_OWNER", "AGENTBOOK_FILES"]) delete env[k];

async function req(method: string, p: string, { body, cookie, base = URL }: { body?: unknown; cookie?: string; base?: string } = {}): Promise<Json> {
  const r = await fetch(base + p, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const buf = Buffer.from(await r.arrayBuffer());
  let data: Json = {};
  try {
    data = JSON.parse(buf.toString("utf8"));
  } catch {}
  return { status: r.status, headers: r.headers, buf, cookie: (r.headers.get("set-cookie") || "").split(";")[0], ...data };
}
const as = (cookie: string, base = URL) => ({ cookie, get: (p: string) => req("GET", p, { cookie, base }), post: (p: string, body?: unknown) => req("POST", p, { cookie, base, body: body || {} }) });
const pic = (url: string) => `/api/sessions/sess-a/picture?url=${encodeURIComponent(url)}`;

let err = "";
async function serve(base: string, more: Record<string, string> = {}) {
  const child = spawnAgentbook({ env: { ...env, ...more }, stdio: ["ignore", "ignore", "pipe"] });
  child.stderr.on("data", (d) => (err += d));
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(base + "/api/health")).ok) break;
    } catch {}
    await sleep(100);
  }
  return child;
}
let server = await serve(URL);
let hub = { kill() {} };
try {
  const owner = as((await req("POST", "/api/auth/test-person", { body: { username: "herval" } })).cookie);
  const alice = as((await req("POST", "/api/auth/test-person", { body: { username: "alice" } })).cookie);
  const nobody = as(null);

  // A post whose agent put pictures in a reply, a result and a note; and one its person typed.
  await req("POST", "/api/hello", { body: { proc: "box-1", label: "wren", agent: "Claude", session_id: "sess-a", cwd: HOME } });
  await req("POST", "/api/procs/box-1/post", { body: { title: "Draw a cat" } });
  const names = ["cat.png", "moved.png", "away.png", "page.html", "big.png"].map((n) => `![${n}](${SITE}/${n})`);
  const blocked = ["http://169.254.169.254/latest/meta-data/x.png", "http://10.0.0.1/x.png", `http://[::1]:${away}/x.png`, `http://[::ffff:127.0.0.1]:${away}/x.png`, `http://localhost:${(site.address() as AddressInfo).port}/cat.png`];
  await req("POST", "/api/procs/box-1/messages", { body: { from: "agent", text: `Here it is: ${names.join(" ")}\n\n${blocked.map((u) => `![x](${u})`).join(" ")}` } });
  await req("POST", "/api/procs/box-1/updates", { body: { text: `Drew it ![result](${SITE}/result.png)` } });
  await req("POST", "/api/procs/box-1/attachments", { body: { key: "n", type: "note", data: { text: `![note](${SITE}/note.png)` } } });
  await req("POST", "/api/procs/box-1/messages", { body: { from: "human", text: `Like ![this](${SITE}/human.png)?` } });
  await req("POST", "/api/procs/box-1/files", { body: { name: "notes.md", content_base64: Buffer.from(`# Notes\n\n![in a file](${SITE}/in-file.png)`).toString("base64") } });

  // ---------- the copy kept with the post ----------
  const first = await owner.get(pic(`${SITE}/cat.png`));
  check(first.status === 200 && first.headers.get("content-type") === "image/png" && first.buf.equals(PNG), "a picture in a reply comes through agentbook, as it is");
  check(/sandbox/.test(first.headers.get("content-security-policy") || "") && first.headers.get("x-content-type-options") === "nosniff", "sandboxed, so one opened on its own can't run anything");
  const again = await owner.get(pic(`${SITE}/cat.png`));
  check(again.status === 200 && again.buf.equals(PNG) && asked["/cat.png"] === 1, "the site is asked once: after that, it's the copy kept here");
  const kept = path.join(HOME, "server", "files", "pictures", "post-sess-a");
  check(fs.existsSync(kept) && fs.readdirSync(kept).some((f) => f.endsWith(".json")), "kept with the post, in the server's files folder");
  const dl = await owner.get(`${pic(`${SITE}/cat.png`)}&download=1`);
  check(dl.status === 200 && /^attachment; filename\*=UTF-8''cat\.png$/.test(dl.headers.get("content-disposition") || ""), "?download=1 saves it, under its own name");
  check((await owner.get(pic(`${SITE}/result.png`))).status === 200 && (await owner.get(pic(`${SITE}/note.png`))).status === 200, "pictures in results and notes too");
  check((await owner.get(pic(`${SITE}/in-file.png`))).status === 200, "and in a markdown file of the post's");
  check((await owner.get(pic(`${SITE}/moved.png`))).status === 200 && asked["/cat.png"] === 2, "a picture that moved is followed to where it is now");

  // ---------- not an open proxy ----------
  check((await owner.get(pic(`${SITE}/other.png`))).status === 404 && !asked["/other.png"], "an address the post doesn't have is never fetched");
  check((await owner.get(pic(`${SITE}/human.png`))).status === 404 && !asked["/human.png"], "nor one a person typed: only what its agent wrote shows as pictures");
  check((await owner.get(pic(`${SITE}/page.html`))).status === 415, "something that isn't a picture isn't passed on");
  check((await owner.get(pic(`${SITE}/big.png`))).status === 413, "nor a picture over 10 MB");
  const away1 = await owner.get(pic(`${SITE}/away.png`));
  check(away1.status === 403, `a site that sends it on to this machine gets nothing (${away1.status} ${away1.error})`);
  const inside = await Promise.all(blocked.map((u) => owner.get(pic(u))));
  check(
    inside.every((r) => r.status === 403),
    `nothing from this machine, its network or a cloud's metadata, however it's written (${inside.map((r) => r.status).join(", ")})`,
  );

  // ---------- pictures on this machine ----------
  // An agent names a screenshot it took by its path, often in a folder that's emptied soon after.
  const shots = path.join(HOME, "shots");
  fs.mkdirSync(shots);
  const shot = path.join(shots, "shot.png");
  const PNG2 = Buffer.concat([PNG, Buffer.from("again")]);
  fs.writeFileSync(shot, PNG);
  fs.writeFileSync(path.join(shots, "rel.png"), PNG);
  fs.writeFileSync(path.join(shots, "fake.png"), "not a picture at all");
  fs.writeFileSync(path.join(shots, "typed.png"), PNG);
  await req("POST", "/api/procs/box-1/messages", { body: { from: "agent", text: `Here's how it looks:\n\n![the sidebar](${shot})\n\n![from its folder](shots/rel.png) ![fake](${shots}/fake.png)` } });
  await req("POST", "/api/procs/box-1/messages", { body: { from: "human", text: `And ![this](${shots}/typed.png)?` } });
  const local = await owner.get(pic(shot));
  check(local.status === 200 && local.headers.get("content-type") === "image/png" && local.buf.equals(PNG), `a picture its agent names by its path on this machine comes through agentbook (${local.status} ${local.error || ""})`);
  check((await owner.get(pic("shots/rel.png"))).status === 200, "a path from the session's folder too");
  check((await owner.get(pic(`${shots}/fake.png`))).status === 415, "a file that isn't a picture isn't passed on, whatever it's called");
  check((await owner.get(pic(`${shots}/typed.png`))).status === 404, "nor a path a person typed");
  check((await owner.get(pic(path.join(HOME, "cli", "agentbook.db")))).status === 404, "nor one the post doesn't have");
  fs.rmSync(shot);
  check((await owner.get(pic(shot))).buf.equals(PNG), "when the file's gone, the copy kept stays");
  // The same path, named again with something else there: kept as it is now.
  fs.writeFileSync(shot, PNG2);
  await req("POST", "/api/procs/box-1/updates", { body: { text: `Fixed it ![after](${shot})` } });
  let renamed = null;
  for (let i = 0; i < 30 && !renamed?.buf.equals(PNG2); i++, await sleep(50)) renamed = await owner.get(pic(shot));
  check(renamed?.buf.equals(PNG2), "named again, a picture is kept as it is now");
  // Kept as soon as it's named, not when it's first looked at.
  const gone = path.join(shots, "gone.png");
  fs.writeFileSync(gone, PNG);
  await req("POST", "/api/procs/box-1/messages", { body: { from: "agent", text: `![soon gone](${gone})` } });
  await sleep(200);
  fs.rmSync(gone);
  check((await owner.get(pic(gone))).status === 200, "kept as soon as its agent names it, before anyone looks");

  // ---------- pictures a turn put side by side (ab_compare), and the links its agent wrote, as cards ----------
  const after = path.join(shots, "after.png");
  const before = path.join(shots, "before.png");
  fs.writeFileSync(after, PNG2);
  fs.writeFileSync(before, PNG);
  check(/https address/.test((await req("POST", "/api/procs/box-1/shape", { body: { compare: { kind: "before_after", pictures: [`${SITE}/before.png`, after] } } })).error || ""), "a compare's picture on the web is https only, as a card's is");
  const shaped = await req("POST", "/api/procs/box-1/shape", { body: { compare: { kind: "before_after", pictures: [{ picture: before, label: "Before" }, { picture: after, label: "After" }] } } });
  check(shaped.status === 200, `ab_compare's pictures on this machine are taken (${shaped.status} ${shaped.error || ""})`);
  await req("POST", "/api/procs/box-1/messages", { body: { from: "agent", text: `Done, see ${SITE}/article.html for the release.` } });
  let side = null;
  for (let i = 0; i < 30 && side?.status !== 200; i++, await sleep(50)) side = await owner.get(pic(after));
  check(side?.status === 200 && side.buf.equals(PNG2) && (await owner.get(pic(before))).buf.equals(PNG), "a compare's pictures are sent up as it's called, and come through agentbook from its reply");
  fs.rmSync(before);
  check((await owner.get(pic(before))).status === 200, "kept, once its file's gone");
  // A card's picture on this machine (ab_cards' `image: "/tmp/mock.png"`) the same way: the page asks for it here.
  const mock = path.join(shots, "mock.png");
  fs.writeFileSync(mock, PNG2);
  check((await req("POST", "/api/procs/box-1/shape", { body: { cards: [{ title: "Branch the review", image: mock }] } })).status === 200, "ab_cards' pictures on this machine are taken");
  await req("POST", "/api/procs/box-1/messages", { body: { from: "agent", text: "Two ways to go." } });
  let cardPic = null;
  for (let i = 0; i < 30 && cardPic?.status !== 200; i++, await sleep(50)) cardPic = await owner.get(pic(mock));
  check(cardPic?.status === 200 && cardPic.buf.equals(PNG2), "a card's picture is sent up as it's called, and comes through agentbook from its reply");
  const link = (u) => `/api/sessions/sess-a/link?url=${encodeURIComponent(u)}`;
  const card = await owner.get(link(`${SITE}/article.html`));
  check(card.status === 200 && card.title === "Release 2.4 & notes" && card.text === "What changed" && card.site === "Acme" && card.image === true, `a link its agent wrote is a card: its page's title, description, site and picture (${card.status} ${card.error || card.title})`);
  const og = await owner.get(`/api/sessions/sess-a/link/picture?url=${encodeURIComponent(`${SITE}/article.html`)}`);
  check(og.status === 200 && og.buf.equals(PNG), "its picture comes through the picture proxy");
  await owner.get(link(`${SITE}/article.html`));
  check(asked["/article.html"] === 1, "the page is read once, then the card is kept");
  check((await owner.get(link(`${SITE}/other.html`))).status === 404 && !asked["/other.html"], "a link the thread doesn't have is never read");
  check((await alice.get(link(`${SITE}/article.html`))).status === 404, "nor for someone who can't see the thread");

  // ---------- who sees it ----------
  check((await alice.get(pic(`${SITE}/cat.png`))).status === 404, "someone else gets nothing from a private post, even what's kept already");
  check((await alice.get(pic("shots/rel.png"))).status === 404, "nor a picture from this machine");
  check((await nobody.get(pic(`${SITE}/cat.png`))).status === 401, "nor does someone signed out");
  // Public is for its owner's contacts.
  await alice.post("/api/people/herval/contact", { act: "ask" });
  await owner.post("/api/people/alice/contact", { act: "yes" });
  await owner.post("/api/sessions/sess-a/visibility", { visibility: "public" });
  const seen = await alice.get(pic(`${SITE}/cat.png`));
  check(seen.status === 200 && seen.buf.equals(PNG) && asked["/cat.png"] === 2, "on a public post they see it, from the copy here: the site never hears of them");
  check((await alice.get(pic(shot))).buf.equals(PNG2), "and its agent's pictures from this machine, from the copy too");
  check((await alice.get(pic(`${SITE}/in-file.png`))).status === 200, "and a markdown file's pictures, which are work: whoever sees a thread sees its work");

  // ---------- pages ----------
  const page = await req("POST", "/api/procs/box-1/pages", { body: { title: "Cats", widgets: [{ id: "o", type: "options", title: "Which", data: { items: [{ name: "Tabby", image: `${SITE}/option.png` }] } }] } });
  const ppic = (url) => `/api/pages/${page.id}/picture?url=${encodeURIComponent(url)}`;
  check((await owner.get(ppic(`${SITE}/option.png`))).status === 200, "an option's picture on a page comes through agentbook too");
  check((await owner.get(ppic(`${SITE}/cat.png`))).status === 404, "and only what the page has");
  check((await alice.get(ppic(`${SITE}/option.png`))).status === 404, "someone else sees nothing of a private page");
  await req("POST", "/api/procs/box-1/pages", { body: { page: page.id, widgets: [{ id: "o", type: "options", title: "Which", data: { items: [{ name: "Tabby" }] } }] } });
  check((await owner.get(ppic(`${SITE}/option.png`))).status === 200, "a picture an older version had still shows on that version");
  // One on the agent's machine, by its whole path: its machine sends it with the write, and the page keeps it.
  const drawn = path.join(shots, "drawn.png");
  fs.writeFileSync(drawn, PNG);
  await req("POST", "/api/procs/box-1/pages", { body: { page: page.id, widgets: [{ id: "n", type: "note", title: "Drawn", data: { text: `![drawn](${drawn})` } }] } });
  fs.rmSync(drawn);
  const onPage = await owner.get(ppic(drawn));
  check(onPage.status === 200 && onPage.buf.equals(PNG), `a picture on its agent's machine, named in a page by its path, is kept with the page (${onPage.status} ${onPage.error || ""})`);
  check((await owner.get(ppic(path.join(shots, "rel.png")))).status === 404, "but not one the page doesn't name");

  // ---------- through a hub ----------
  // The laptop logs in to a hub, where alice looks at its posts: the hub fetches each picture once, keeps it with
  // the post, and passes it on to whoever may see the post. The laptop is never asked.
  hub = await serve(HUB, { AGENTBOOK_PORT: String(HUB_PORT), AGENTBOOK_HOME: path.join(HOME, "hub"), AGENTBOOK_MACHINE: "hub" });
  const hubOwner = as((await req("POST", "/api/auth/test-person", { base: HUB, body: { username: "herval" } })).cookie, HUB);
  const hubAlice = as((await req("POST", "/api/auth/test-person", { base: HUB, body: { username: "alice" } })).cookie, HUB);
  const asking = await req("POST", "/api/devices/start", { base: HUB, body: { name: "laptop" } });
  await hubOwner.post("/api/devices/approve", { code: asking.code });
  const token = (await req("GET", `/api/devices/poll?poll=${encodeURIComponent(asking.poll)}`, { base: HUB })).token;
  server.kill();
  await sleep(300);
  server = await serve(URL, { AGENTBOOK_HUB: HUB, AGENTBOOK_HUB_TOKEN: token, AGENTBOOK_MACHINE: "laptop" });
  await req("POST", "/api/procs/box-1/messages", { body: { from: "agent", text: `And one more: ![hub](${SITE}/hub.png)` } });
  await req("POST", "/api/hello", { body: { proc: "box-2", label: "kite", agent: "Claude", session_id: "sess-b", cwd: HOME } });
  await req("POST", "/api/procs/box-2/messages", { body: { from: "agent", text: `![private](${SITE}/private.png)` } });
  for (let i = 0; i < 130 && !(await hubOwner.get("/api/sessions/sess-a")).messages?.some((m) => /hub\.png/.test(m.text)); i++) await sleep(150);
  // Public is for its owner's contacts.
  await hubAlice.post("/api/people/herval/contact", { act: "ask" });
  await hubOwner.post("/api/people/alice/contact", { act: "yes" });
  await hubOwner.post("/api/sessions/sess-a/visibility", { visibility: "public" });
  const there = await hubAlice.get(`/api/sessions/sess-a/picture?url=${encodeURIComponent(`${SITE}/hub.png`)}`);
  check(there.status === 200 && there.headers.get("content-type") === "image/png" && there.buf.equals(PNG) && asked["/hub.png"] === 1, `on a hub, a picture in someone else's public post comes through the hub, which fetched it once (${there.status} ${there.error || ""})`);
  const hubKept = path.join(HOME, "hub", "server", "files", "pictures", "post-sess-a");
  check(fs.existsSync(hubKept) && fs.readdirSync(hubKept).length > 0, "and keeps it there, with the post");
  const hidden = await hubAlice.get(`/api/sessions/sess-b/picture?url=${encodeURIComponent(`${SITE}/private.png`)}`);
  check(hidden.status === 404 && !asked["/private.png"], "a private post's pictures aren't fetched for anyone else, through a hub either");

  // ---------- the site goes away ----------
  const seenOnHub = await hubOwner.get(pic(`${SITE}/cat.png`));
  await new Promise((r) => site.close(r));
  site.closeAllConnections?.();
  check(seenOnHub.status === 200 && (await hubOwner.get(pic(`${SITE}/cat.png`))).status === 200, "when the site goes away, the picture stays");
} catch (e) {
  console.error(e);
  failures++;
} finally {
  server.kill();
  hub.kill();
  site.close();
  if (failures && err) console.error(err);
  fs.rmSync(HOME, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
